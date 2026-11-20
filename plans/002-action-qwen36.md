# Plan 002 — Analysis & action plan: escaping the phone-to-relay BLE hop

> **Author**: qwen36 · **Date**: 2026-11-20 · **Type**: analysis + action plan
> **Baseline**: `walkpadspeed` `0ed72f1`, `hr-relay` `4402df5`
> **Companion documents**: `plans/001-hr-relay-lan-api.md`, `plans/002-prompt.md`, `plans/002-walkpadspeed-lan-hr-client-gpt6luna.md`, `plans/002-action-hy4-flash-free.md`, `plans/README.md`

## 1. Problem statement

The phone's Chrome browser (v157+) cannot reliably connect to the COROS HR strap over Web Bluetooth. The Chrome 157 regression (unsolicited vendor notifications → NPE → CCCD write never acknowledged → `startNotifications()` hangs) was identified 2026-11-15. The hr-relay (Linux + BlueZ) connects to the strap cleanly and re-advertises as a standard HR belt, but the phone-to-relay BLE hop is itself unreliable: the app connects, then disconnects after ~39 s, while the relay continues emitting HR data.

The user asks three questions:
1. Can the app work around this and talk to the COROS strap directly?
2. Can a connection to the relay over Wi-Fi (HTTP/TCP/UDP) work?
3. Why did the app disconnect after 39 s while the relay kept emitting?

## 2. Root-cause analysis

### 2.1 Direct COROS BLE — already tried, already broken

The app's direct BLE path to the COROS strap is the same path that failed on 2026-11-13. The Chrome 157 regression is a Blink-level defect: the band streams proprietary telemetry on vendor characteristics alongside standard HR, and Chrome's GATT layer throws NPE per notification, drowning the callback thread before the CCCD write completes. The app has been hardened for this (optional-services wrapper warm-up, first-beat race, phantom-link detection, `forget()`, reload hint) — all in `openHrmGatt()`. These hardening measures are necessary but insufficient against the Chrome 157 defect.

**Verdict**: Direct COROS is mutually exclusive with the relay (the strap serves one central at a time). Even if a new workaround existed, it would break the known-good relay path. **Keep direct COROS as a fallback only.**

### 2.2 Wi-Fi LAN connection — the right direction

Raw TCP/UDP is impossible from page JavaScript. WebTransport is overkill for a 1 Hz BPM value. **HTTP GET polling is the correct transport.** The phone and relay are on the same LAN. The relay is a Linux box with a static IP and a BLE dongle — it's always reachable from the phone when both are on the same network.

**Key constraint (2026 browser reality):** From an `https://` page, an `http://` LAN request requires Local Network Access (LNA) handling — Chrome 145+ requires `targetAddressSpace: 'local'` on the Request, a permission query, and a user gesture. This is a one-time user prompt per origin. Firefox/Safari lack LNA; handle `TypeError` from `permissions.query` as a failure.

### 2.3 The 39 s disconnect — likely causes

| Hypothesis | Mechanism | Evidence needed |
|---|---|---|
| **H1** — Chrome 157 NPE race | The relay's BLE peripheral presents a clean 0x2A37, but the relay's own peripheral handling may have quirks that trigger the same NPE path | App trace shows `HRM disconnected` ~39 s after `HRM notifications on` |
| **H2** — Relay drops the phone client | TinyGo peripheral handling, resume-watch restart, or advertising reset kills the BLE link | Relay journal shows its connected client dropping at the same second |
| **H3** — App bug (connect budget) | 39 s ≈ `HRM_CONNECT_BUDGET_MS` (40 s); the connect sequence ran out of budget | App trace shows `hrmFailCount` incrementing, no `HRM notifications on` |
| **H4** — Strap → relay leg dropped | The relay's `HR … bpm` lines stopped at t=39 s | Relay journal stops logging BPM at t=39 s |

**Diagnostic priority**: Align timestamps from (a) app debug trace (include `build=` line), (b) `journalctl --user -u hr-relay.service -n 200`, (c) phone `logcat` if available. This is a ~15 min exercise that should run in parallel with the LAN client work — the LAN client works regardless of which hypothesis is correct.

## 3. Architecture decision

```
[ COROS strap ] --BLE--> hr-relay (Linux + BlueZ) --HTTP--> phone browser
   (clean)          cleans to 0x2A37              GET /api/v1/hr
                                              1 Hz polling
```

**Why HTTP polling over WebSocket:**
- 1 Hz is trivial for HTTP (one tiny JSON response per second)
- No persistent connection to manage; network errors are self-healing
- No LNA difference between HTTP and WS — both need the same permission
- Simpler to debug, test, and reason about
- SSE is an alternative but adds complexity for no measurable benefit at 1 Hz

**Why not a native bridge app:**
- Breaks the single-file app model
- Requires app store distribution (Android) or sideloading
- The HTTP approach works from any browser on any platform

## 4. Design

### 4.1 HR transport abstraction

The app currently uses `hrmCharacteristic` as a dual-purpose signal: "BLE characteristic object" AND "HR source available". This is a design smell that will cause bugs when adding a second transport.

**New state model:**

```js
// Transport state: null | 'ble' | 'lan' | 'test'
let hrTransport = null;

// Freshness: the relay returns sampleSeq (monotonic) and sampleAgeMs
// The app uses sampleSeq to dedupe and sampleAgeMs to detect staleness
let hrSampleSeq = 0;
let hrSampleAgeMs = Infinity;

// The existing hrmCharacteristic stays as-is for BLE-only uses
// (disconnect handler, characteristic object access)
```

**`hrmConnected()` replacement:** Instead of `return !!hrmCharacteristic`, use `return hrTransport !== null && hrSampleAgeMs <= 5000`. This covers all transports uniformly.

### 4.2 BPM processing — single shared path

Extract the BPM update logic from `handleHrmNotification()` into a helper:

```js
function processHrSample(bpm, seq, ageMs) {
    // 1. Validate: bpm is positive integer, seq is non-negative integer
    // 2. Dedupe: if seq <= hrSampleSeq, return (already processed)
    // 3. Update: currentHeartRate, hrHistory, hrSampleSeq, hrSampleAgeMs
    // 4. Call: updateHrmUI(), updateHrZone(), updateHrTrend()
    // 5. Return: true if processed, false if stale/duplicate
}
```

The existing BLE handler decodes Heart Rate Measurement bytes → calls `processHrSample()`. The LAN poller receives JSON → calls `processHrSample()`. Test Mode already has its own path via `simulateHrTick()` → `handleHrmNotification()` — leave it as-is (it's a separate code path that works).

### 4.3 LAN poller

```js
let lanPollAbort = null;
let lanEndpoint = null;
let lanToken = null;

async function startLanPoll() {
    // Read endpoint/token from localStorage (endpoint) and session storage (token)
    // Poll GET /api/v1/hr with Authorization header
    // Use recursive setTimeout (not setInterval) to avoid overlapping requests
    // Validate response shape: { sensorConnected, bpm, sampleSeq, sampleAgeMs }
    // Call processHrSample() on valid new sample
    // Handle stale: if sampleAgeMs > 5000 or sensorConnected === false, clear BPM
    // Handle errors: network errors do NOT increment hrmFailCount
}

function stopLanPoll() {
    if (lanPollAbort) { lanPollAbort.abort(); lanPollAbort = null; }
}
```

### 4.4 UI on Connections view

Add a new section below the existing BLE HR button:

```
┌─────────────────────────────────────┐
│  Heart Rate Monitor                 │
│  [Connect to Heart Rate Monitor]    │  ← BLE (existing #connectHrmBtn)
│  Not connected                      │
│                                     │
│  ─────────────────────────────────  │
│  Connect over Wi-Fi                 │
│  Relay URL: [____________] [Test]   │
│  Token:      [____________]         │
│  Not connected                      │
└─────────────────────────────────────┘
```

- Endpoint URL persisted in `localStorage` (`wpss_lan_hr_endpoint`)
- Token stored in `sessionStorage` (session-only, cleared on tab close)
- "Test" button validates connectivity before committing
- Status line shows transport source: "HR via Wi-Fi: 72 bpm" vs "HR via BLE: 72 bpm"

### 4.5 Security

- **Bearer token**: session-only, never logged, never echoed in status/debug text
- **CORS**: exact-origin only (set by relay operator), `Vary: Origin`
- **LNA**: Chrome 145+ requires `targetAddressSpace: 'local'` on the Request
- **No private URLs in code comments or README**

## 5. Implementation steps

### Step 1: Extract shared BPM processing helper

**File**: `walkpadspeed.html`

Extract the BPM update logic from `handleHrmNotification()` (line ~2224) into `processHrSample(bpm, seq, ageMs)`. The BLE handler continues to decode Heart Rate Measurement flags/uint8/uint16, then calls the helper. Test Mode stays unchanged.

**Verify**: `node --check` on extracted inline script; existing BLE HR still works; Test Mode still works.

### Step 2: Add LAN poller infrastructure

**File**: `walkpadspeed.html`

Add `startLanPoll()`, `stopLanPoll()`, `hrTransport`, `hrSampleSeq`, `hrSampleAgeMs`. Implement bounded HTTP polling with `AbortController`. Validate response shape. Handle stale data (sampleAgeMs > 5000, sensorConnected === false, null BPM). Network errors must not increment `hrmFailCount`.

**Verify**: Mock the fetch to return fresh/stale/failed responses; verify BPM updates, stale detection, and error recovery.

### Step 3: Wire up `hrmConnected()` and transport guards

**File**: `walkpadspeed.html`

Replace `hrmConnected()` (line ~4813) with `return hrTransport !== null && hrSampleAgeMs <= 5000`. Update all non-BLE-specific `hrmCharacteristic` truthiness checks: zone-targeted steps, zone-terminated steps, HR zone control, resume/step navigation, session logging. Keep direct `hrmCharacteristic` access where actual BLE operations or disconnects require the characteristic object.

**Verify**: Zone control activates/deactivates correctly with LAN transport; session logging includes LAN-sourced BPM; zone-terminated steps work with LAN.

### Step 4: Add Connections view UI

**File**: `walkpadspeed.html`

Add LAN HR endpoint field, token field, "Connect over Wi-Fi" / disconnect buttons on the Connections view. Persist endpoint in `localStorage`, token in `sessionStorage`. Show transport source in status text. Add "Test" button for reachability check.

**Verify**: Manual UI check — separate BLE and Wi-Fi choices; existing BLE Connect button still works; endpoint persists across reload; token is session-only.

### Step 5: Add Playwright test

**File**: `test/hrm-lan.test.cjs`

Cover: LAN connect success; valid response updates BPM/zone/history; same `sampleSeq` processed once; stale/null/offline response clears HR; HTTP and JSON errors are visible and recoverable; disconnect stops polling; switching to Test Mode cleans up LAN polling; LAN mode does not call `navigator.bluetooth.requestDevice`; existing BLE mode remains available.

**Verify**: `test/RUN-ALL-TESTS` → `ALL TESTS PASSED`; type error count ≤ 36.

### Step 6: Update README

**File**: `README.md`

Add HR-monitoring section with LAN setup using placeholders, token handling, Android local-network permission, stale-data behavior, and troubleshooting. Never include a real private host/domain, token, or secret.

### Step 7: Version bump and commit

Bump CSS version from `v1.2.0-dev.6` to `v1.2.0-dev.7`. Load `auto-commit` skill. Stage changes. Commit with `feat: add LAN heart-rate client to walkpadspeed`. Do not push.

## 6. Verification matrix

| Test | Command | Expected |
|------|---------|----------|
| Inline JS syntax | `node -e '...' && node --check /tmp/walkpadspeed-inline.js` | Exit 0 |
| Type check | `test/check-types.cjs` | Error count ≤ 36 |
| Full test suite | `test/RUN-ALL-TESTS` | `ALL TESTS PASSED` |
| Relay API tests | `cd ../hr-relay && go test ./...` | Exit 0 |
| Relay build | `cd ../hr-relay && go build -o /tmp/hr-relay .` | Exit 0 |
| Phone end-to-end | Android Chrome, same LAN | BPM/zone/control work over Wi-Fi |

## 7. Risk assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| LNA permission blocks the request | Medium | Design option D (same-origin HTTPS proxy) as fallback; verify on actual phone before coding |
| BLE HR regression during refactor | Medium | Keep BLE path untouched; test BLE HR after every change |
| Test Mode regression | Low | Test Mode stays as a separate code path; verify after BPM extraction |
| CORS misconfiguration by relay operator | Low | Relay plan 001 handles this; app rejects non-200 responses |
| Stale data drives zone control | Medium | Freshness predicate (sampleAgeMs ≤ 5000) prevents stale BPM from being used |

## 8. STOP conditions

- Plan 001's Android reachability gate has not passed.
- The secure app origin cannot reach the endpoint without weakening browser protections or exposing a wildcard/public service.
- The live API shape differs from plan 001; stop and reconcile before changing either side.
- Supporting LAN HR would require changing HR zone algorithms, session-log schema, treadmill behavior, or the direct COROS BLE protocol.
- Any regression appears in BLE HR or Test Mode after two focused attempts to diagnose it; stop and report rather than broadening the refactor.

## 9. Open questions for Colas

1. Is the app's HTTPS origin under your control (needed for option D — same-origin HTTPS proxy — if the LNA gate fails)?
2. Does the 39 s trace correspond to a link dying or to the connect budget expiring? (Check `build=` line in the trace to confirm deployed version.)
3. Is wireless adb still paired for `logcat` capture on the phone?
4. Has the hr-relay API (plan 001) been implemented and deployed for testing? If not, this plan depends on it.

## 10. Non-goals

- No changes to the relay's strap-side BLE code, COROS parsing, or advertising behavior.
- No changes to HR zone algorithms, session-log schema, treadmill control, or incline handling.
- No private server URL, token, or secret in user-visible text or documentation.
- No native bridge app, WebRTC, WebTransport, or public tunnel.
- No changes to the existing BLE HR code path beyond extracting the shared BPM helper.
