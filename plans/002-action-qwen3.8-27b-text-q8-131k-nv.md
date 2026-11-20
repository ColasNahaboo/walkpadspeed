# Plan 002 — Analysis & action plan: a Wi-Fi HR feed for walkpadspeed

> **Author**: qwen3.8-27b-text-q8-131k-nv · **Date**: 2026-11-20 · **Type**: analysis + action plan
> **Baseline**: `walkpadspeed` `0ed72f1` (v1.2.0-dev.6), `hr-relay` `4402df5`
> **Companion**: `plans/001-hr-relay-lan-api.md`, `plans/002-prompt.md`, `plans/README.md`

## 0. TL;DR

- **Direct COROS from the app: no.** It is the exact path that is broken (Chrome 157
  NPE wedge), and the strap serves one central at a time, so it would also kill the
  known-good relay path. Keep it only as a manual fallback.
- **Wi-Fi to the relay: yes, and it is the right fix.** The phone and relay are on the
  same LAN. Replace the unstable phone→relay BLE hop with a 1 Hz `GET /api/v1/hr`
  poll. Raw TCP/UDP is impossible from page JS; WebTransport is overkill for one BPM
  per second.
- **The 39 s disconnect is most likely the app's own connect budget, not the relay.**
  `HRM_CONNECT_BUDGET_MS = 40000` (40 s) is within 1 s of the reported 39 s. This must
  be confirmed from the trace before we assume the relay dropped the client.
- **This plan is BLOCKED until Plan 001 is implemented and its Android reachability
  gate passes.** Plan 001 is not implemented yet (verified: no HTTP code in
  `hr-relay/main.go`, no `main_test.go`).

## 1. The three questions, answered

### Q1 — Can the app work around the relay and use the COROS strap directly?

No, not as a primary path.

- The direct path is the one that is already failing. The 2026-11-15 diagnosis
  (Chrome 157 regression) is a Blink-level defect: the COROS band streams unsolicited
  vendor notifications, Chrome's GATT callback NPEs on them, and the CCCD write for
  `startNotifications()` is never acknowledged. The app is already hardened for this
  (`openHrmGatt()`: optional-services warm-up, first-beat race, phantom-link
  detection, `forget()`, reload hint) — and it still fails on the phone.
- The strap serves **one central at a time**. If the app connects directly, the relay
  loses the strap, and we lose the only path that currently works.
- **Verdict:** keep direct COROS as a manual fallback (it works on some days / some
  browsers), but do not build the workaround around it.

### Q2 — Can the app reach the relay over Wi-Fi (HTTP/TCP/UDP)?

Yes — over **HTTP**, not raw TCP/UDP.

- Browser page JS cannot open raw TCP/UDP sockets. WebTransport datagrams are not
  warranted for a 1 Hz BPM value.
- The phone and relay are on the same LAN, and the relay is a Linux box with a BLE
  dongle that is reachable whenever both are on the network.
- **One `GET /api/v1/hr` per second** is the correct transport: trivial load, no
  persistent connection to manage, self-healing on network errors, and the same
  Local Network Access (LNA) permission model as any other cross-origin fetch.
- **Browser constraint (2026 reality):** from an `https://` page, an `http://` LAN
  request is subject to **Local Network Access** (Chrome 145+ requires
  `targetAddressSpace: 'local'` on the Request, a permission query, and a user
  gesture) plus **CORS** (exact-origin, set by the relay operator). This must be
  verified on the actual Android browser before any app code is written.

### Q3 — Why did the app disconnect after 39 s while the relay kept emitting?

Ranked hypotheses (confirm with the trace before acting):

| # | Hypothesis | Mechanism | Evidence to check |
|---|-----------|-----------|-------------------|
| **H1** | **App connect budget** | `HRM_CONNECT_BUDGET_MS = 40000` (40 s) ≈ the reported 39 s. If `startNotifications` never resolved, the budget expired and the app gave up — the relay kept streaming to nobody. | App trace: is there an `HRM notifications on` line? Is there a `HRM GATT attempt … failed` / budget-exceeded line at ~39 s? |
| **H2** | Relay dropped the phone client | TinyGo peripheral handling, the resume-watch restart, or an advertisement reset killed the BLE link. | `journalctl --user -u hr-relay.service` — a `client disconnected:` line at the same second. |
| **H3** | Strap→relay leg dropped | The relay's `HR … bpm` lines stopped at t=39 s. | Relay journal stops logging BPM at t=39 s. |
| **H4** | Chrome 157 NPE race on the relay's peripheral | The relay presents a clean 0x2A37, but a quirk triggers the same NPE path. | Phone `logcat` (adb) during the connect. |

**H1 is the strongest lead** because the number matches the app's own constant. The
LAN client works regardless of which hypothesis is correct, so the diagnostic and the
implementation can proceed in parallel.

## 2. Architecture

```
[ COROS strap ] --BLE--> hr-relay (Linux + BlueZ) --HTTP--> phone browser
   (clean)          cleans to 0x2A37              GET /api/v1/hr, 1 Hz poll
```

The relay already owns the reliable strap subscription. We only replace the
phone→relay hop. The app gains a **second HR transport** without touching HR zones,
session logging, treadmill control, or the working BLE path.

## 3. Design

### 3.1 Transport state (the core refactor)

`hrmCharacteristic` is currently a dual-purpose signal: "BLE characteristic object"
**and** "HR source available". Test Mode even sets it to `true` (line 2078). Adding a
second transport on top of that will cause bugs. Introduce an explicit transport:

```js
let hrTransport = null;          // null | 'ble' | 'lan' | 'test'
let hrSampleSeq = 0;             // last processed relay sampleSeq (idempotency key)
let hrSampleAgeMs = Infinity;    // last relay sampleAgeMs (freshness)
```

`hrmConnected()` becomes a freshness predicate that covers all transports:

```js
function hrmConnected() {
    return hrTransport !== null && hrSampleAgeMs <= 5000;
}
```

Keep `hrmCharacteristic` for the places that genuinely need the BLE object
(disconnect handler, `gatt.disconnect()`, the `characteristicvaluechanged` listener).

### 3.2 One shared BPM pipeline

Extract the body of `handleHrmNotification()` (lines 2224–2241) into a helper that
both transports call:

```js
function processHrSample(bpm, seq, ageMs) {
    // validate: positive safe-integer bpm
    // dedupe: if seq != null && seq <= hrSampleSeq, return false
    // update: currentHeartRate, hrHistory (1 Hz, pruned to 4 min), hrSampleSeq, hrSampleAgeMs
    // first-beat: stopHrmBeatWatchdog() + trace
    // UI: updateHrmUI('connected', bpm); updateHrZone(bpm)
    // return true
}
```

- **BLE handler** keeps decoding the Heart Rate Measurement flags/uint8/uint16, then
  calls `processHrSample(bpm, null, 0)` (no seq — BLE is push-based, no dedupe needed).
- **LAN poller** calls `processHrSample(bpm, sampleSeq, sampleAgeMs)` and relies on
  the seq dedupe so an unchanged relay response is not re-logged.
- **Test Mode** keeps its own path (`simulateHrTick()` → `handleHrmNotification()`);
  it works and is a separate code path.

### 3.3 LAN poller

```js
let lanPollTimer = null;
let lanEndpoint = null;   // from localStorage wpss_lan_hr_endpoint
let lanToken = null;      // from sessionStorage (session-only)

async function lanPollOnce() {
    // fetch(lanEndpoint, { headers: { Authorization: 'Bearer ' + lanToken },
    //                     targetAddressSpace: 'local' })   // LNA, Chrome 145+
    // validate: 200, JSON, sensorConnected, positive safe-integer bpm,
    //           non-negative safe-integer sampleSeq/sampleAgeMs
    // stale: sensorConnected===false || bpm==null || sampleAgeMs>5000
    //        → clear currentHeartRate, show stale status, do NOT drive zone control
    // fresh: processHrSample(bpm, sampleSeq, sampleAgeMs)
    // network error: visible status, do NOT increment hrmFailCount, do NOT trigger
    //                the BLE "reload the tab" path
}

function startLanPoll() {
    // recursive setTimeout (not setInterval) so requests never overlap
    // first tick immediate, then every 1000 ms
}

function stopLanPoll() {
    if (lanPollTimer) { clearTimeout(lanPollTimer); lanPollTimer = null; }
}
```

### 3.4 Connections-view UI

Add a separate Wi-Fi HR block below the existing BLE HR card. Do **not** repurpose
`#connectHrmBtn` — the user must still be able to pick the BLE path.

```
┌──────────────────────────────────────────┐
│  Heart Rate Monitor (Bluetooth)          │
│  [Connect to Heart Rate Monitor]         │  ← existing #connectHrmBtn
│  Not connected                           │
├──────────────────────────────────────────┤
│  Heart Rate Monitor (Wi-Fi / relay)      │
│  Relay URL: [________________]           │  ← localStorage wpss_lan_hr_endpoint
│  Token:     [________________]           │  ← sessionStorage (session-only)
│  [Connect over Wi-Fi]  [Test]            │
│  Not connected                           │
└──────────────────────────────────────────┘
```

- Endpoint persisted in `localStorage` (`wpss_lan_hr_endpoint`).
- Token in `sessionStorage` only (cleared on tab close); never shown in status/debug
  text, never in the README.
- "Test" validates reachability (one authorized `GET /api/v1/hr`) before committing.
- Status line names the transport: "HR via Wi-Fi: 72 bpm" vs "HR via BLE: 72 bpm".

### 3.5 Security

- Bearer token, session-only, never logged/echoed.
- CORS exact-origin only (relay operator sets it), `Vary: Origin`.
- LNA `targetAddressSpace: 'local'` on the Request (Chrome 145+).
- No private host/domain/token in code comments, README, or user-visible text.

## 4. Action plan

> **Gate (must pass first):** Plan 001 implemented in `hr-relay` **and** its Android
> reachability gate (plan 001 step 4) passed. If the phone's secure origin cannot
> fetch the endpoint without weakening browser security, this plan is BLOCKED.

### Step 0 — Confirm the 39 s cause (parallel, ~15 min)

Pull the app debug trace (check the `build=` line to confirm the deployed version) and
`journalctl --user -u hr-relay.service -n 200`. Determine whether the 39 s is H1
(budget), H2 (relay drop), or H3 (strap leg). This does not block the LAN work but
informs whether the BLE path also needs a fix.

### Step 1 — Extract the shared BPM helper

**File**: `walkpadspeed.html`. Extract `handleHrmNotification()` body into
`processHrSample(bpm, seq, ageMs)`. BLE handler decodes then calls it with `seq=null`.
Test Mode unchanged.

**Verify**: `node --check` on the extracted inline script; BLE HR and Test Mode still
work.

### Step 2 — Add the LAN poller + transport state

**File**: `walkpadspeed.html`. Add `hrTransport`, `hrSampleSeq`, `hrSampleAgeMs`,
`startLanPoll()`, `stopLanPoll()`, `lanPollOnce()`. Recursive `setTimeout`,
`AbortController`-style cancellation, response-shape validation, stale handling, and
error handling that does not touch `hrmFailCount`.

**Verify**: mock fetch (fresh / stale / failed) in a Playwright test; BPM updates,
stale clears within 5 s, errors recover.

### Step 3 — Rewire `hrmConnected()` and the non-BLE guards

**File**: `walkpadspeed.html`. Replace `hrmConnected()` with the freshness predicate.
Update the non-transport-specific `hrmCharacteristic` truthiness checks used by
zone-targeted steps, zone-terminated steps, HR zone control, resume/step navigation,
and session logging. Keep direct `hrmCharacteristic` access where a BLE object is
required.

**Verify**: zone control activates/deactivates with the LAN transport; session log
includes LAN-sourced BPM; zone-terminated steps work over LAN.

### Step 4 — Connections-view UI

**File**: `walkpadspeed.html`. Add the Wi-Fi HR block (endpoint + token + Connect +
Test). Persist endpoint in `localStorage`, token in `sessionStorage`. Show transport
source in the status text.

**Verify**: manual UI check — separate BLE and Wi-Fi choices; existing BLE button
still opens the chooser; endpoint persists across reload; token is session-only.

### Step 5 — Playwright test

**File**: `test/hrm-lan.test.cjs` (new). Cover: LAN connect success; valid response
updates BPM/zone/history once; same `sampleSeq` processed once; stale/null/offline
clears HR; HTTP and JSON errors visible and recoverable; disconnect stops polling;
Test Mode switching cleans up LAN polling; LAN mode does not call
`navigator.bluetooth.requestDevice`; existing BLE mode remains available.

**Verify**: `test/RUN-ALL-TESTS` → `ALL TESTS PASSED`; type error count ≤ 36.

### Step 6 — README

**File**: `README.md`. Add an HR-monitoring section: LAN setup with placeholders,
token handling, Android local-network permission, stale-data behavior, troubleshooting.
No real private host/domain/token/secret.

### Step 7 — Version bump + commit

Bump the CSS version `v1.2.0-dev.6` → `v1.2.0-dev.7`. Load the `auto-commit` skill.
Stage the in-scope changes. Commit `feat: read heart rate over LAN`. Do not push.

## 5. Verification matrix

| Test | Command | Expected |
|------|---------|----------|
| Inline JS syntax | extract `<script>` → `node --check` | Exit 0 |
| Type check | `test/check-types.cjs` | Error count ≤ 36 |
| Full suite | `test/RUN-ALL-TESTS` | `ALL TESTS PASSED` |
| Relay API | `cd ../hr-relay && go test ./...` | Exit 0 |
| Relay build | `cd ../hr-relay && go build -o /tmp/hr-relay .` | Exit 0 |
| Phone end-to-end | Android Chrome, same LAN | BPM/zone/control over Wi-Fi; stale + recovery |

## 6. Risks

| Risk | Likelihood | Mitigation |
|------|-----------|-----------|
| LNA permission blocks the request | Medium | Verify on the real phone first (gate); same-origin HTTPS proxy as fallback |
| BLE HR regression during refactor | Medium | Keep the BLE path untouched; test BLE HR after every step |
| Test Mode regression | Low | Test Mode stays a separate path; verify after the helper extraction |
| Stale data drives zone control | Medium | Freshness predicate (`sampleAgeMs ≤ 5000`) gates `hrmConnected()` |
| CORS misconfiguration | Low | Plan 001 owns it; the app rejects non-200 / malformed responses |

## 7. STOP conditions

- Plan 001's Android reachability gate has not passed.
- The secure app origin cannot reach the endpoint without weakening browser
  protections or exposing a wildcard/public service.
- The live API shape differs from plan 001 — reconcile before changing either side.
- Supporting LAN HR would require changing HR zone algorithms, the session-log schema,
  treadmill behavior, or the direct COROS BLE protocol.
- A BLE HR or Test Mode regression persists after two focused diagnostic attempts —
  stop and report rather than broadening the refactor.

## 8. Open questions for Colas

1. Is the app's HTTPS origin under your control (needed for the same-origin HTTPS
   proxy fallback if the LNA gate fails)?
2. Does the 39 s trace show a link dying or the connect budget expiring? (Check the
   `build=` line to confirm the deployed version.)
3. Is wireless adb still paired for `logcat` capture on the phone?
4. Has plan 001 been implemented and deployed? This plan is BLOCKED until it is.

## 9. Non-goals

- No changes to the relay's strap-side BLE code, COROS parsing, or advertising.
- No changes to HR zone algorithms, session-log schema, treadmill control, or incline.
- No private server URL, token, or secret in user-visible text or documentation.
- No native bridge app, WebRTC, WebTransport, or public tunnel.
- No changes to the existing BLE HR path beyond extracting the shared BPM helper.
