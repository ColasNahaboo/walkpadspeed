# Plan 002 — Analysis & action plan: a heart-rate feed that does not depend on the phone's BLE hop

> **Author**: DeepSeek V4.1 Flash Free · **Date**: 2026-11-20 · **Type**: analysis only (no source files changed)
> **Baselines**: `walkpadspeed` `0ed72f1` (v1.2.0-dev.6), `hr-relay` `4402df5`
> **Companion documents**: `plans/001-hr-relay-lan-api.md`, `plans/002-prompt.md`, the four other
> `plans/002-action-*.md`, `hr-relay/docs/IOS-PLANS.md`, `walkpadspeed/docs/bugreport-google-chrome-v157.md`

## 1. Direct answers to the three questions

1. **"Can the app work around this and use the COROS strap directly?"**
   It already does: the app has spoken the standard Heart Rate service (`0x180D` / `0x2A37`)
   since v1.0. The blocker is a **Chrome 157 Blink defect**, documented in
   `docs/bugreport-google-chrome-v157.md`: the strap pushes unsolicited notifications on
   vendor characteristics, Chrome's Java wrapper throws an NPE per notification, and the CCCD
   write completion is never delivered. Every page-side mitigation is already in `openHrmGatt()`
   (optional services, full wrapper warm-up, first-beat race, phantom-link handling, `forget()`).
   One more idea is unavailable: the measurement characteristic is **notify-only** (`read=false`),
   so `readValue()` polling is impossible. **No new app-only direct-COROS workaround exists.**
   Keep it as a fallback for unaffected browsers (Vivaldi connects after a few retries).

2. **"Can the app reach the relay over Wi-Fi with HTTP, TCP or UDP?"**
   **Yes for HTTP; no for raw TCP/UDP.** Ordinary page JavaScript has no raw sockets. WebTransport
   needs HTTPS/QUIC and is absurd for one integer per second. A protected `GET /api/v1/hr` JSON
   poll once per second is the right transport — but *where the page is served from* matters more
   than the transport (§5): the public-origin + Local Network Access route is workable but gated
   by a permission prompt that may not appear; serving the app **from the relay over HTTPS**
   removes the gate, the CORS preflight and the cleartext token all at once.

3. **"Why did the app disconnect after 39 s while the relay kept emitting?"**
   The 2026-11-19 journal answers it more precisely than "unknown" (§2): the relay had a healthy
   strap subscription and forwarded HR (82→78 bpm) for the whole 39 s, and the phone's ACL
   appeared **exactly once** and dropped **exactly once**. The app's `openHrmGatt()` closes the
   link and reconnects on every failed attempt, so a failed connect would show 2–3 ACL entries.
   It shows one. **The link was up and then died, and the app has no auto-reconnect** — so it
   stayed dead for the rest of the session. That is a real app gap and is fixable independently
   of the transport (P1 below).

**Recommendation**: fix the relay's central-leg reliability and add app auto-reconnect first
(cheap, no new architecture), then add the LAN feed with a transport abstraction, and prefer the
same-origin HTTPS topology over the LNA/CORS one if the phone gate is at all awkward.

## 2. What the logs actually show (evidence not in the other plans)

### 2.1 The 39 s event, minute by minute

From `journalctl --user -u hr-relay.service --since "2026-11-19 20:20:45"`:

| Time | Event |
|---|---|
| 20:10:01 → 20:20:46 | relay cannot scan: `Operation already in progress`, retried every 5 s for **10 minutes** |
| 20:20:49 | `client connected: D1:F9:…` — this is the relay's **own central** link to the strap, not a phone |
| 20:20:51 | `sensor found` / `sensor connected` / `subscribed to sensor heart-rate notifications` |
| 20:20:52 | `client connected: 45:E1:E4:…` — **the phone** |
| 20:20:53 → 20:21:29 | `HR 82 bpm` … `HR 78 bpm` … `HR 82 bpm` — **fresh data forwarded the whole time** |
| 20:21:31 | `client disconnected: 45:E1:E4:… (disconnected)` — **39 s after the single connect** |
| 20:21:36 → 20:21:48 | HR continues (`83, 84, 85, 86 bpm`): the strap leg never noticed |

### 2.2 What that rules out

- **Not the app's 3-attempt budget.** A failed `openHrmGatt()` disconnects in its `catch` and
  reconnects (lines 2019–2044). Three attempts would leave 2–3 phone ACL entries. There is one.
- **Not the strap leg.** `HR … bpm` is emitted in `onSensorData()` while handling *source*
  notifications; it proves the COROS→relay leg, and it was continuous.
- **Not "the relay emitted but the phone was never connected".** The phone *was* connected at the
  ACL level and the relay was forwarding. What failed is the GATT subscription or the link itself,
  neither of which the relay logs.

### 2.3 What it does not rule out

Two candidates remain, and the app's `?dbg=1` trace plus one `btmon` capture separate them:

- **H-B (phone-side)**: Chrome/Android dropped a live ACL (screen off, Doze, Chrome's stack). The
  app trace would show `HRM notifications on` then `HRM disconnected`.
- **H-R (relay-side)**: the relay's TinyGo/BlueZ backend never serviced the phone's CCCD write or
  its notifications, because its D-Bus loop was busy with the central role. The trace would show
  `HRM link up` then `HRM disconnected` **without** `HRM first BPM n` (the 15 s first-beat
  watchdog would have said "connected but sending no data").
  - Decisive test: `sudo btmon -i hci0 -w /tmp/phone.snoop` on the relay host while connecting,
    then decode it. A working subscribe looks exactly like `docs/btmon-bluez-hrm-subscribe-ok.txt`:
    `ATT: Write Request` (CCCD) → `ATT: Write Response` in ~16 ms → `Handle Value Notification`.
    If the relay never sends the Write Response or the notifications, it is H-R; if it does, H-B.
  - Note the 39 s value is **not** a BLE supervision timeout (the spec caps it at 32 s), which
    weakens a pure radio-loss story and slightly favours a phone-stack policy decision.
- **H-U (user-initiated)**: a tap on "Disconnect Heart Rate Monitor" on the Connections view
  (line 4904) produces the same one-connect/one-disconnect pattern and writes no trace line today.
  Adding `trace('HRM user disconnect')` to `disconnectHRM()` (P1) makes this distinguishable in
  one glance; it is worth doing even if the current event turns out to be H-B.

### 2.4 The relay's central leg is itself unreliable — this is the bigger risk

The HTTP API is only as good as the COROS→relay leg, and that leg is structurally fragile:

- **10-minute stall on 2026-11-19** (table above) and **~6-hour stall overnight**: the
  `Operation already in progress` retries stop at `01:35:01` and the next line, at `07:33:17`, is a
  single `Method "Get" with signature "ss" … doesn't exist`, after which a scan finally started. The
  process was blocked inside `adapter.Scan`, not in its retry loop (a blocked loop logs every 5 s;
  there are no lines for 6 h). The D-Bus error is what an adapter object that was re-registered
  underneath the process looks like — consistent with the host resuming from suspend and BlueZ
  rebuilding `hci0`, which accidentally unblocked the old call.
- **Mechanism** (`main.go:131-190`): `adapter.Scan()` is not cancellable. On the 15 s timeout the
  code calls `adapter.StopScan()` from another goroutine and returns, but the `Scan` call itself
  may still be live; the next iteration calls `Scan` again and gets `Operation already in progress`,
  forever. Every strap link loss re-enters this race.
- **Today's state is idle, not wedged**: `bluetoothctl show` reports `Discovering: yes`, the last
  log line is `07:33:22 scanning for sensor…`, and there is no strap advertising (it is off).
  That is normal. The wedge is the *previous* state and will return.

### 2.5 The journal cannot see a GATT subscription

`main.go:253-271` registers a connection-state handler on the adapter. It reports ACLs, so it
logs the relay's own central link to the strap (`D1:F9:…`) with exactly the same line shape as a
phone client, and it cannot tell a subscribed phone from an ACL that never completed a CCCD write.
That is why "HR RELAY emitted" and "the app never connected" could both be true. Fix: expose
forwarding counters and source state in the HTTP snapshot (§4.4), and stop describing ACLs as
clients in the log text.

## 3. Options

| Option | Feasible from the page? | Effort | Verdict |
|---|---|---|---|
| **A. Direct COROS, new workaround** | Already implemented; Chrome 157 defect | Low to try, high to make reliable | **Reject as primary.** One timeboxed re-test on the current browser, then stop. |
| **B. HTTP poll to relay from the public origin** (plans 001+002) | Yes, via LNA | Medium | **Workable.** Gated on the phone LNA prompt (§5). |
| **C. Raw TCP / UDP** | **No** — no raw sockets in page JS | — | **Reject.** |
| **D. WebSocket / SSE to relay** | Yes, also LNA-gated | Medium | Viable later behind the same `pushBpm()` interface; unnecessary at 1 Hz. |
| **E. Same-origin HTTPS: relay serves the app + API** | Yes — no LNA, no CORS | Medium (cert + serving) | **Preferred if the LNA gate is awkward**, and the cleanest long-term topology (§5.3). |
| **F. Native phone bridge app** | n/a | High | **Reject.** Already deferred by `IOS-PLANS.md`. |
| **G. Harden BLE only (auto-reconnect, relay watchdog)** | Yes | Low | **Do it anyway** (P0/P1), but it does not remove the fragile hop. |

## 4. Design

### 4.1 One HR source, explicit transports

`hrmCharacteristic` currently means both "BLE characteristic object" and "HR source available";
Test Mode even sets it to `true` (line 2078). Add an explicit transport and keep the
characteristic for real BLE operations only:

```js
let hrTransport = null;      // null | 'ble' | 'lan' | 'test'
let hrSampleSeq = 0;         // last processed LAN sampleSeq
let hrRelayId = null;        // relay process id (see 4.5)
let hrSampleAt = 0;          // local Date.now() of the last accepted LAN sample
let hrSampleAgeMs = null;    // relay-reported age of that sample
const HR_STALE_MS = 5000;
```

`hrmConnected()` becomes transport-aware:

```js
function hrmConnected() {
    if (hrTransport === 'lan') return hrSampleAgeMs !== null && hrSampleAgeMs <= HR_STALE_MS
                                    && Date.now() - hrSampleAt <= HR_STALE_MS;
    return !!hrmCharacteristic;   // BLE and Test Mode keep their current semantics
}
```

Replace only the **non-transport** truthiness checks (table in §7.1). Keep `hrmCharacteristic`
for `gattserverdisconnected`, `startNotifications`, and the BLE cleanup paths.

### 4.2 One BPM pipeline

Extract the body of `handleHrmNotification()` (2224–2241) into an idempotent helper:

```js
function applyHrSample(bpm) {
    if (!Number.isSafeInteger(bpm) || bpm <= 0 || bpm > 300) return false;
    currentHeartRate = bpm;
    hrHistory.push({ t: Date.now(), speed: currentTargetSpeed, hr: bpm });
    const cutoff = Date.now() - 240000;
    while (hrHistory.length && hrHistory[0].t < cutoff) hrHistory.shift();
    updateHrmUI('connected', bpm);
    updateHrZone(bpm);
    return true;
}
```

- BLE handler: decode flags/uint8/uint16, do the first-beat bookkeeping, then `applyHrSample(bpm)`.
- Test Mode: `simulateHrTick()` already builds a fake `DataView` and calls the BLE handler, so it
  keeps working untouched.
- LAN poller: call it **once per new `(relayId, sampleSeq)`**, never per poll.

### 4.3 Freshness: what stale must stop — and what it must not clear

On stale (`sensorConnected === false`, `bpm === null`, `sampleAgeMs > 5000`, or no new `sampleSeq`
for > 5 s):

- set `currentHeartRate = 0` — this is the existing guard in `applyHrmZoneAdjust()`
  (`currentHeartRate <= 0`), so **speed control stops without touching the zone interval**;
- clear `hrHistory` and `resetHrTrend()` so a resumed feed does not inherit a stale trend;
- `updateHrZone(0)` and a `'stale'` HR-box state (see §7.3);
- `recordSessionState()` writes no HR for that segment.

**Do not clear `hrmStepTargetZone`** (a correction to one of the other plans): clearing it makes
`applyHrmZoneAdjust()` return forever, so zone control would never resume when the strap comes
back. Leave the target armed; the `currentHeartRate <= 0` guard is the correct gate.

### 4.4 Relay snapshot contract — amendments to plan 001

Plan 001's shape is right; add four fields and one rule:

```json
{
  "relayId": "3f9c1a2b",          // random per process, NEW
  "version": "4402df5+http",      // NEW, for build confirmation
  "sensorConnected": true,
  "bpm": 104,
  "sampleSeq": 1234,
  "sampleAgeMs": 250,
  "forwardErrors": 0,             // NEW: hrm.Write() failures
  "lastForwardOkMs": 120          // NEW: null until the first successful forward
}
```

- **`relayId` is mandatory** (§4.5). `sampleSeq` alone is unsafe across relay restarts.
- `sensorConnected` is the **subscription** state, set true only after `EnableNotifications`
  succeeds and false when `forward()` returns — not the adapter's ACL state.
- `sampleAgeMs` is `null` until the first real measurement (not `0` at subscribe time).
- `forwardErrors` / `lastForwardOkMs` turn the invisible phone-side failure of §2.5 into a
  visible number: "relay has a fresh sample but has never forwarded" is a diagnosable state.
- Keep the endpoint read-only, opt-in, token-protected, LAN-bound, exact-origin CORS. Add
  `Access-Control-Max-Age: 600` so the `Authorization` preflight is not repeated on every poll,
  and compare the token with `subtle.ConstantTimeCompare`.

### 4.5 Why `sampleSeq` alone is a trap

The relay is restarted by `systemd` (`Restart=always`, and by the new watchdog in P0). A restarted
process starts `sampleSeq` at 1. An app that dedupes on `sampleSeq <= lastSeq` would then reject
**every** sample forever — a silent, total failure that looks exactly like "the LAN feed is
broken". Two acceptable fixes; pick one:

1. `relayId` (recommended): a random hex string per process; the app resets `hrSampleSeq` when it
   changes.
2. A persisted, monotonic counter — rejected: it needs state on disk for no benefit.

## 5. The LNA gate (verified against current guidance, not memory)

### 5.1 What is mandatory for option B

The app is served from a public HTTPS origin (`https://walkpad.fr`); the relay is `http://192.168.x.y:PORT`.
Current guidance (`local-network-access`, modern-web-guidance 2026-11) requires **all** of:

- **Secure context** — already true (Web Bluetooth requires it too).
- **`targetAddressSpace` on the `Request`/`fetch`** — mandatory for an `http://` target from an
  `https://` page. It provides the Mixed Content exemption *before DNS resolution* and makes the
  browser verify the resolved IP really belongs to the declared space.
- **`navigator.permissions.query({ name: 'local-network' })`** in `try/catch`:
  `granted` → connect automatically; `prompt` → explain and issue the **first** request from the
  "Connect over Wi-Fi" click; `denied` → remediation UI, no retry loop; listen for `change`.
- **Never query the legacy name `'local-network-access'`** — it can crash older Chrome renderers
  and `try/catch` cannot catch that.
- **No PNA preflight headers** (`Access-Control-Request-Private-Network` is deprecated and ignored).
- Chrome/Edge **145+** only; Firefox and Safari have no LNA. Feature-detect: a `TypeError` from
  `permissions.query` means "treat as prompt"; a `TypeError` from `fetch` means "blocked".

### 5.2 The address-space trap (this will bite the tests)

`targetAddressSpace` must match the **resolved** address space: the browser verifies the resolved
IP really belongs to the declared space and aborts with a `TypeError` when it does not. Loopback is
a separate, more private space than `local`, so declaring `'local'` for `127.0.0.1` fails the check:

| Endpoint host | Declare |
|---|---|
| `192.168.x.y`, `10.x.y.z`, `172.16–31.x.y`, `fe80::/10`, `fc00::/7`, `*.local` | `'local'` |
| `127.0.0.1`, `::1`, `localhost`, `*.localhost` | `'loopback'` |

So the app needs `addressSpaceFor(host)` rather than a hard-coded `'local'`, **and the Playwright
test must not send `'local'` for a `localhost` mock** — it would fail with an address-space
mismatch that looks like a bug in the app. Test against `'loopback'`, or omit the option when the
test origin is loopback, and assert the option separately with a `fetch` spy.

### 5.3 Option E: serve the app from the relay over HTTPS (no LNA at all)

```
https://<lan-host>/walkpadspeed.html   ── same origin ──▶  /api/v1/hr
        ▲                                                      ▲
        └── relay (TLS, static file + JSON) ───────────────────┘
```

- The page and the API share one origin, so no address-space crossing occurs: **no LNA prompt,
  no CORS, no preflight**.
- The bearer token travels over TLS instead of cleartext, and there is no public origin in the path.
- Web Bluetooth still works (valid certificate ⇒ secure context ⇒ treadmill control unaffected).
- Certificate: a real cert for a LAN hostname via ACME **DNS-01** (the name resolves to a private
  IP; DNS-01 does not need the host to be reachable) is the clean option. A local CA installed on
  the phone (`mkcert`) also works, but do not rely on clicking through a certificate warning —
  confirm `window.isSecureContext === true` before assuming Web Bluetooth is available.
- Costs: the app URL changes; `localStorage` is per-origin, so the cached routines file is reloaded
  once; the relay must serve a copy of the HTML (fetch the published file at startup, or serve it
  from a directory).
- This is also the topology `hr-relay/docs/IOS-PLANS.md` already assumes (a local origin serving
  the app and a same-origin HR source), so it does not create a second architecture.

**Gate**: run a 10-minute probe from the phone before writing client code. Open the deployed app
from its real origin, query `local-network`, click a button that fetches the relay with
`targetAddressSpace: 'local'`, and record the permission state, HTTP status, CORS headers and the
exact error text. If it is blocked and option E is acceptable, take E; do not weaken CORS or
browser security to force B.

## 6. Action plan (ordered)

### P0 — Make the relay self-healing and honest (relay repo, ~1 h)

1. **Single long-lived scan loop.** Call `adapter.Scan` **once per process** and never again; the
   callback pushes matching advertisements to a buffered channel, and `main` consumes it
   (`Connect` → subscribe → `forward` → `Disconnect` → cooldown). This deletes the
   `StopScan`/`Operation already in progress` race entirely. Guard against re-connecting to the
   address that is already connected, and ignore scan results while a connect is in flight.
2. **Watchdog.** Track `lastProgress` (scan result, connect, sample, client connect) and
   `lastScanErr`. If no progress for `-watchdog-secs` (default 600) **and** a scan error is
   present, `log.Fatal` → `systemd` `Restart=always` gives a fresh D-Bus session. This is the only
   reliable way to escape a wedged `adapter.Scan`, which cannot be cancelled.
3. **Stop dropping a quiet but healthy link at 60 s.** Raise `-stale-secs` default to 300 and
   document that `sampleAgeMs` is now the client-side freshness signal. The 60 s value is the main
   source of reconnect churn while the strap is off-body (before or after a workout), and every
   reconnect re-enters the scan race.
4. **Log truthfully.** Do not call the strap's own ACL a "client"; log source state separately and
   count `hrm.Write()` failures.

**Verify**: `go test ./...`, `go build -o /tmp/hr-relay .`; then restart the unit and confirm
`Discovering: yes` with no repeated `Operation already in progress` over a 5-minute window, and
that killing the strap link causes exactly one reconnect, not a retry storm.

### P1 — App auto-reconnect on link loss (quick win, ~1 h, independent of everything else)

Today `attachHrmDisconnectHandler()` (2054–2067) resets state and stops: nothing reconnects, so a
39 s drop costs the whole session. Add:

- `hrmUserDisconnected` flag set in `disconnectHRM()`, cleared in `connectHRM()`;
- on `gattserverdisconnected`, if `!hrmUserDisconnected && hrmDevice && hrTransport === 'ble'`,
  schedule up to 3 reconnects with 2/4/8 s backoff through the existing `openHrmGatt()` (which
  already handles phantom links), re-attach the `characteristicvaluechanged` listener, and set
  `hrmCharacteristic` on success;
- do **not** increment `hrmFailCount` from auto-reconnect (that drives the "reload the tab" hint);
  use a separate counter and stop after 3 tries with a clear status line;
- `disconnectHRM()` must not null `hrmDevice` when the intent is a reconnect; keep the device
  reference so `gatt.connect()` needs no new user gesture;
- add `trace('HRM user disconnect')` to `disconnectHRM()` so a manual disconnect is
  distinguishable from a link drop in the log (§2.3, H-U);
- also retry once on `visibilitychange` → visible if the link is down.

**Verify**: in Test Mode the reconnect logic must not run; with a real strap, power-cycle it
mid-routine and confirm the app recovers without a manual tap.

### P2 — Relay HTTP API (plan 001, amended by §4.4)

Follow plan 001 steps 1–3, with the `relayId`/`version`/`forwardErrors`/`lastForwardOkMs` additions,
the `OPTIONS` + `Access-Control-Max-Age` preflight, constant-time token comparison, and an
`-http` listen address that must be an explicit LAN address (refuse `0.0.0.0` unless
`-allow-any-bind` is given). Keep the listener opt-in and read-only.

**Verify**: `go test ./...` with `httptest` covering fresh/no-sample/stale/disconnected, seq
monotonicity, `relayId` change, missing/wrong token, wrong origin, `GET`/`OPTIONS`/`PUT`, and the
disabled-by-default configuration.

### P3 — App LAN client (plan 002, amended by §4 and §5)

1. Add the transport state, `addressSpaceFor()`, and `applyHrSample()` (§4.1–4.2); replace the
   guard sites in §7.1.
2. Add the Connections-view card: endpoint (localStorage `wpss_lan_hr_url`), token
   (sessionStorage `wpss_lan_hr_token`, `type=password`), Connect/Disconnect, Test, and a status
   line. Starting LAN must `disconnectHRM()` first; starting BLE must `stopLanPoll()` first.
3. Poll with a serialized `setTimeout` chain (`await` then schedule, never `setInterval`), a 3 s
   `AbortController` timeout per request, and `cache: 'no-store'`. Back off to 5 s on network
   errors; stop on 401/403 with a clear "token rejected" message.
4. Accept a sample only when `(relayId, sampleSeq)` is new; treat `seq` regression with an
   unchanged `relayId` as a protocol error and stop polling rather than replaying.
5. Stale handling per §4.3; `applyTestMode()` must call `stopLanPoll()`; the disconnect path must
   `clearTimeout` and `abort()`.
6. Never put the endpoint or token in the URL, the debug trace, `updateStatus()` text, or the
   session log.

**Verify**: `test/hrm-lan.test.cjs` (mock `fetch`, no LNA) plus the existing suite; the inline
`node --check`; `check-types.cjs` error count must stay **≤ 36** (see §7.2).

### P4 — Phone end-to-end and, if needed, option E

Connect over Wi-Fi, confirm BPM/zone/zone-control, cover the strap → stale within 5 s and speed
stops adapting, restore → recovery; confirm BLE HR remains selectable and that disconnecting one
transport does not mark the other connected; confirm the debug log contains no token. If the LNA
gate fails, implement §5.3 instead of weakening anything.

## 7. Code-level notes (`walkpadspeed.html` at `0ed72f1`)

### 7.1 Guard sites that must move off `hrmCharacteristic`

| Line | Context | Current | Change |
|---|---|---|---|
| 2318 | `enterStepSpeed` zone-skip | `… && hrmCharacteristic && currentHeartRate > 0` | `hrmConnected()` |
| 2409 | `startHrmZoneControl` | `if (!hrmCharacteristic) return;` | `if (!hrmConnected()) return;` |
| 2834 | resume into a zone step | `… && hrmCharacteristic` | `hrmConnected()` |
| 2912 | step transition zone control | `hrmCharacteristic && currentHeartRate > 0` | `hrmConnected()` |
| 2938 | step transition zone control | `… && hrmCharacteristic` | `hrmConnected()` |
| 3450, 3483 | clock loop zone-terminate | `… && hrmCharacteristic` | `hrmConnected()` |
| 3618 | remote start | `… && hrmCharacteristic` | `hrmConnected()` |
| 3780 | `recordSessionState` | `const hrOn = !!hrmCharacteristic;` | `const hrOn = hrmConnected();` |
| 4814 | `hrmConnected()` definition | `return !!hrmCharacteristic;` | §4.1 |
| 5189 | routine start | `… && hrmCharacteristic` | `hrmConnected()` |

Keep `hrmCharacteristic` at 2061, 2115, 2154, 2205, 2215 (BLE lifecycle) and 2078 (Test Mode
truthy flag, alongside `hrTransport = 'test'`).

### 7.2 Type-check baseline

`targetAddressSpace` is not in the DOM typings that `tsc --checkJs` uses, so a literal
`new Request(url, { targetAddressSpace: 'local' })` **raises the error count above 36** and fails
`test/check-types.cjs`. Pass the init as `/** @type {any} */` (or a local `@typedef`) and keep the
baseline unchanged. Do not raise `BASELINE` to accommodate it.

### 7.3 UI and status

- `updateConnStatus()` (4823–4854) reads `hrmDevice.name`; for LAN `hrmDevice` is `null`. Branch on
  `hrTransport` and show: `Connected over Wi-Fi: <host>` / `Relay reachable, no fresh HR data` /
  `Relay unreachable (<reason>)`.
- Add a `'stale'` state to `updateHrmUI()` (2580–2616) that shows `- -` with a distinct
  `box.title`, so a stale feed does not look like a live reading; keep the zone strip hidden or
  greyed, and remember `lastHrmUiState` triggers `updateConnStatus()`.
- The HR box is display-only since v1.2; do not add a second connect affordance there.

### 7.4 Token hygiene

`updateStatus()` mirrors text to `#connStatus` and `trace()` persists to `localStorage`
(`wpss_debug_log`). Neither may ever receive the token or a URL containing it. Log the host only.

## 8. Test plan

- **`test/hrm-lan.test.cjs`** (new, Playwright + the existing static-server style): fresh sample
  updates BPM/zone/history exactly once per `sampleSeq`; a repeated `sampleSeq` is not re-processed;
  a `relayId` change resets dedupe; `sensorConnected:false` / null BPM / `sampleAgeMs > 5000` /
  frozen `seq` all go stale within 5 s and stop zone adjustments; 401 stops polling with a visible
  message; a network error backs off and recovers; disconnect aborts in-flight requests and stops
  the timer; Test Mode switching stops the poller; LAN mode never calls
  `navigator.bluetooth.requestDevice`; BLE mode still works; `addressSpaceFor()` returns
  `'loopback'` for localhost and `'local'` for a private IP.
- **Fetch-spy assertion**: capture the `RequestInit` and assert the address space is set, so a
  future refactor cannot silently drop the option.
- **Relay**: `go test ./...` with `httptest`; `go build -o /tmp/hr-relay .`.
- **App**: `test/RUN-ALL-TESTS` → `ALL TESTS PASSED`; `check-types.cjs` ≤ 36; inline `node --check`.
- **Manual, mandatory**: the phone LNA probe (§5.3 gate) and the end-to-end run (P4). Headless
  tests cannot reproduce Chrome Android's permission prompt.

## 9. Risks and STOP conditions

| Risk | Likelihood | Mitigation |
|---|---|---|
| LNA prompt never appears / is denied on the phone | Medium | Take option E (§5.3); never wildcard CORS or insecure content |
| `targetAddressSpace` mismatch (`local` vs `loopback`) | Medium | `addressSpaceFor()`; loopback in tests |
| `sampleSeq` reset after a relay restart freezes the feed | High if unaddressed | `relayId` (§4.5) |
| Stale data drives zone control | Medium | `currentHeartRate = 0` + existing guard; `recordSessionState` gate |
| BLE/Test-Mode regression from the guard sweep | Medium | Change only the table in §7.1; run Test Mode after each step |
| Relay wedge returns | High | P0 watchdog + single scan loop |

**STOP** if: the live API shape differs from plan 001 (reconcile first); the LAN feed would require
changing HR zones, the session-log schema, treadmill control or the COROS protocol; the LNA gate
fails and option E is unacceptable; or a BLE/Test-Mode regression survives two focused attempts.

## 10. Open questions for Colas

1. Is `walkpad.fr` DNS under your control (needed for the DNS-01 cert in option E)? If yes, E is
   strictly better than B and I would skip the LNA path entirely.
2. Can you capture the `?dbg=1` trace of one failed connect (include the `build=` line)? It decides
   H-B vs H-R in §2.3 in under a minute.
3. Is the phone still adb-paired for `logcat`, and can you run `sudo btmon` on the relay host
   during one attempt? That is the decisive relay-side test.
4. Should the relay keep advertising **HR RELAY** when the HTTP listener is on? My preference is
   yes but configurable (`-advertise=false`), because a silent auto-disable is surprising.
5. Is the token worth remembering across tabs (localStorage) or session-only (sessionStorage)?
   Session-only is safer; it costs a re-entry per new tab.

## 11. Non-goals

No code was changed by this analysis. No private host, token or secret appears here. The COROS
protocol, the relay's BLE roles, HR-zone maths, session-log format and treadmill control are out of
scope. The relay's scan-lifecycle fix (P0) is deliberately kept minimal: no new dependencies, no
change to the strap-side GATT protocol.
