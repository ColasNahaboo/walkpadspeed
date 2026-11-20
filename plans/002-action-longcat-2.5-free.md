# Plan 002 — Analysis & action plan: making the HR feed independent of the phone's BLE hop

> **Author**: LongCat 2.5 Free · **Date**: 2026-11-20 · **Type**: analysis only (no source files changed)
> **Baseline**: `walkpadspeed` `0ed72f1` (v1.2.0-dev.6), `hr-relay` `4402df5`
> **Companion documents**: `plans/001-hr-relay-lan-api.md`, `plans/002-walkpadspeed-lan-hr-client-gpt6luna.md`, `plans/002-action-hy4-flash-free.md`, `hr-relay/docs/IOS-PLANS.md`, `walkpadspeed/docs/bugreport-google-chrome-v157.md`

## 1. Direct answers to the three questions

1. **"Can the app work around this and use the COROS strap directly?"** — The app already
   does exactly that (standard Heart Rate service `0x180D` / `0x2A37`), and it is broken by a
   **Chrome 157 browser defect**, not by our code. `docs/bugreport-google-chrome-v157.md`
   documents it: the strap pushes unsolicited notifications on vendor characteristics, Chrome's
   Java wrapper throws an NPE on every one, the per-device callback queue is aborted, and the
   CCCD write completion is never delivered, so `startNotifications()` never resolves. The
   report's own conclusion is *"no web-side workaround exists"*, and the app has already tried
   every page-side mitigation (optional services, full wrapper warm-up, first-beat race,
   phantom-link handling, `forget()`). One extra idea — polling `readValue()` instead of
   notifications — is **not available**: the diagnostic shows the measurement characteristic is
   `notify=true read=false`. So a new app-only direct-COROS workaround is a dead end. Keep the
   existing direct path as a fallback for browsers that are not affected, nothing more.

2. **"Can the phone reach the relay over Wi-Fi (same LAN) with http/tcp/udp?"** — **Yes, and
   HTTP is the right choice.** Raw TCP/UDP is impossible from ordinary page JavaScript (no raw
   sockets; only `fetch`/WebSocket/WebTransport). A 1 Hz BPM value does not need WebTransport
   datagrams or a WebSocket. A small authenticated `GET /api/v1/hr` JSON poll once per second is
   the simplest thing that works and is trivial to test. This is the primary recommendation and
   matches plans 001 + 002.

3. **"Why is the relay unreliable?"** — There are **two separate hops**, and the journal shows
   they fail in different ways. The strap→relay leg is healthy while the strap is worn. The
   phone→relay leg is the fragile one, and the relay's own log actively hides which side failed
   (see §2). Moving only the phone→relay leg to HTTP removes the fragile hop without touching
   the working one.

**Recommendation**: proceed with plans 001 + 002 as the primary direction, amended by §4 (Local
Network Access mechanics — the gpt6luna plan does not spell these out) and §5 (relay logging /
advertising / scan-recovery gaps). Do not invest in a new direct-COROS workaround or a native
bridge app.

## 2. What the logs actually show (evidence not in the other plans)

I pulled `journalctl --user -u hr-relay.service` for 2026-11-19/20. Three findings matter.

**(a) The phone→relay leg drops after 25–58 s, and the relay never reports a forwarding error.**
On 2026-11-19 13:24–13:35 the strap→relay leg streamed continuously (`HR 77…84 bpm`), while
phone clients (Android random MACs) came and went:

```
13:26:35 client connected: 56:F0:EB:69:CA:D1   → 13:27:14 disconnected  (39 s)
13:27:45 client connected: 5F:3B:9F:93:9F:C6   → 13:28:24 disconnected  (39 s)
13:28:59 client connected: 66:D3:4B:7D:1A:B9   → 13:29:57 disconnected  (58 s)
13:30:13 client connected: 75:94:7D:DC:7F:7D   → 13:30:51 disconnected  (38 s)
13:31:31 client connected: 71:D2:ED:D5:27:7E   → 13:32:29 disconnected  (58 s)
```

There is **not one** `forwarding to clients failed` line in the entire journal. So the relay is
not failing to *send*; the BLE ACL between phone and relay is going away. Two hypotheses fit the
~39 s value, and they need different fixes:

- **H-A — the app gives up and disconnects.** `HRM_CONNECT_BUDGET_MS = 40000`
  (`walkpadspeed.html:1892`). The relay logs `client connected` at the ACL level the moment
  `gatt.connect()` resolves, *before* the app's GATT subscription has succeeded. If
  `openHrmGatt()` exhausts its budget, `connectHRM()`'s catch calls `gatt.disconnect()`
  (`walkpadspeed.html:2134-2135`) — which would appear as a ~39 s drop. Under this hypothesis the
  relay's "client connected" line is misleading: it is an ACL, not a working subscription.
- **H-B — the phone's stack drops a live link.** Chrome/Doze/background-tab policy kills the ACL
  ~39–58 s after a *successful* subscribe. The app's `gattserverdisconnected` handler would then
  log `HRM disconnected`.

The app's own `?dbg=1` trace distinguishes them: H-A shows `HRM GATT attempt N failed` and no
`HRM notifications on`; H-B shows `HRM notifications on` then `HRM disconnected`. **Capture that
trace before building anything** — it is ~15 minutes and it decides whether the relay's BLE
peripheral needs a fix too.

**(b) The relay's connection log conflates two different links.** The handler at
`hr-relay/main.go:253-271` is registered for *all* adapter connections, so it logs the relay's
own central link to the strap as `client connected: D1:F9:A6:A2:FC:6D` — exactly the same line
shape as a phone client. That is very likely the source of the "HR RELAY emitted but the app
never connected" confusion: the strap's ACL and the phone's ACL look identical in the journal.
This is a cheap, high-value relay fix: distinguish central (strap) from peripheral (phone)
connection state, and log the phone's GATT subscription separately from its ACL.

**(c) The relay's strap→relay recovery is currently wedged.** Today (2026-11-20) the journal is
1140 × `scan: Operation already in progress` and then silence from 07:33:22 — the process
(PID 3545718, state `Ssl`) is blocked inside a single `adapter.Scan` call and the whole central
loop is stuck. Zero `HR … bpm` lines and zero `client connected` today. The advertisement is
still up (BlueZ alias `HR RELAY`), so a phone can connect to a relay that is forwarding nothing.
Root cause is in `connectSensor()` (`hr-relay/main.go:141-163`): the 15 s timeout path calls
`adapter.StopScan()` from outside the callback, the previous `Scan` never fully returns, and the
next `Scan` fails with "Operation already in progress" until the process is restarted. This is a
**separate relay bug**, out of scope for plan 001, but it must be tracked: the LAN API is only as
good as the strap→relay leg, and today that leg is down. Plan 001's `sensorConnected` /
`sampleAgeMs` fields are exactly what lets the app say "relay has no strap data" instead of
silently showing `--`.

## 3. Option matrix

| Option | Feasible from the page? | Effort | Risk / downside | Verdict |
|---|---|---|---|---|
| **A. Direct COROS BLE, new app workaround** | Already implemented | Low to try, high to make reliable | Chrome 157 defect; characteristic is notify-only so read-polling is impossible; competes with the relay for the strap's single central | **Reject as primary.** One timeboxed re-test on the current browser, then stop. |
| **B. HTTP GET to relay over LAN** (plans 001+002) | Yes — `fetch` + LNA | Medium (two repos, tests) | LNA prompt on Android Chrome is the go/no-go; bearer-token hygiene; stale-data handling | **Primary.** |
| **C. Raw TCP / UDP from the page** | **No** — no raw sockets in page JS | — | WebTransport needs HTTPS/QUIC and is overkill for 1 Hz | **Reject.** |
| **D. WebSocket to relay** | Yes, also LNA-gated | Medium | More server work; LNA for WS is newer; two network clients to maintain | Viable later. `hr-relay/docs/IOS-PLANS.md` already chose a WS source for the phone-app topology — reconcile, don't duplicate (§5). |
| **E. Same-origin HTTPS proxy / public `wss`** | Yes | Medium–High (server, DNS, cert) | New component, public exposure, needs operator config | **Fallback if B's LNA gate fails.** |
| **F. Native phone bridge app** | n/a | High | Breaks the single-file app model; already deferred by IOS-PLANS | **Reject.** |
| **G. Keep BLE relay, harden reconnect only** | Yes | Low | Leaves both the connect failures and the 39 s drops in place | **Not sufficient alone.** |

## 4. The crux: Local Network Access (amendment to plan 002 step 1)

The app is served from a **public HTTPS origin** (`https://walkpad.fr`, or the GitHub Pages
origin). The relay would be `http://192.168.x.y:PORT` — a *local* address space. Since Chrome
142 (and Chrome 156 removed the enterprise opt-out; the phone is on 157) such a request is gated
behind the **Local Network Access** permission. Current guidance
(`developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access`,
2026-11) requires all of the following:

- **Secure context** — already true (Web Bluetooth requires it too).
- **`targetAddressSpace: 'local'`** on the `Request`/`fetch`. This is what exempts the request
  from Mixed Content blocking *and* makes Chrome verify the resolved IP really is local. A
  private IP literal is already mixed-content-exempt; a hostname is not, so the annotation is
  mandatory for anything not a literal.
- **Query `navigator.permissions.query({ name: 'local-network' })`** inside `try/catch`.
  - `'granted'` → connect automatically;
  - `'prompt'` → explain why the app needs the LAN and issue the **first** request from the
    explicit "Connect over Wi-Fi" button click (a user gesture);
  - `'denied'` → show remediation UI (browser site settings) and do not retry in a loop.
  - Listen for `change` so the UI follows the user's setting.
- **Never query the legacy name `'local-network-access'`** — it crashes older Chrome renderers
  and `try/catch` cannot catch it.
- First request must come from a `Document`, not a Service Worker.
- Keep relay-side CORS exact-origin + bearer token; **do not** add PNA preflight headers
  (`Access-Control-Request-Private-Network` / `Access-Control-Allow-Private-Network`) — they
  are deprecated and ignored.

Because the `Authorization` header is not CORS-safelisted, every GET triggers a preflight; the
relay must answer `OPTIONS` with `Access-Control-Allow-Origin` (exact origin), `Vary: Origin`,
`Access-Control-Allow-Headers: Authorization`, and `Access-Control-Allow-Methods: GET, OPTIONS`.
Plan 001 already specifies this.

**Gate consequence:** plan 002 step 1's "verify reachability" must be run with these exact
mechanics, from the phone's real origin, and the exact browser error must be recorded. If Chrome
for Android turns out not to surface the LNA prompt (or denies it), stop and switch to option E —
do **not** weaken CORS, do not move the endpoint to a wildcard, do not fall back to insecure
content.

## 5. Gaps in plans 001 / 002 and `IOS-PLANS.md` (what I would change)

**Plan 001 (relay HTTP API):**
- Add the connection-logging split from §2(b) — it is small and it is what makes the next
  reliability investigation possible.
- Add an explicit **`-advertise=false` / auto-disable advertising when the HTTP listener is
  enabled**. Otherwise the phone's BLE chooser still lists **HR RELAY**, users keep picking it,
  and they keep hitting the broken hop. The whole point of the LAN path is that HR stops using
  BLE on the phone.
- Track the §2(c) scan wedge as its own relay task (do not expand plan 001's scope to fix it, but
  do not let it be forgotten — the HTTP API depends on the central leg recovering).
- Keep the listener opt-in, LAN-bound, token-protected, read-only. Agreed as written.

**Plan 002 (app LAN client):**
- Step 1 must include the §4 LNA mechanics, not just "verify reachability".
- Add the exact guard sites that must move off `hrmCharacteristic` truthiness (from
  `walkpadspeed.html`): `2318`, `2409`, `2834`, `2912`, `2938`, `3450`, `3483`, `3618`, `3780`
  (`recordSessionState`), `5189`, plus `hrmConnected()` at `4813`. Keep `hrmCharacteristic`
  itself for real BLE operations only. Test Mode sets it to `true` (`2078`), which is why an
  explicit `hrTransport` state (`null | 'ble' | 'lan' | 'test'`) is the right fix.
- `updateConnStatus()` reads `hrmDevice.name` (`4849`); for the LAN transport `hrmDevice` is
  `null`, so it must use a transport-specific label.
- The shared BPM helper must be the *only* place that pushes to `hrHistory` and calls
  `updateHrZone`, and it must be idempotent on `sampleSeq` (a repeated BPM is valid and must not
  be dropped; a repeated `sampleSeq` must not be processed twice).
- Stale handling must clear `currentHeartRate`, `hrmStepTargetZone` and stop
  `applyHrmZoneAdjust` — not just grey the metric — so zone control and the session log never
  use an old sample.
- Token entry UI: session-only storage, never in the URL, status text, debug log or README. Note
  honestly that the token crosses the LAN in cleartext (HTTP); on a trusted home LAN that is
  acceptable, but it should be documented and the token should be user-settable.
- Add `test/hrm-lan.test.cjs` (mock `fetch`, no real LNA) and keep `test/RUN-ALL-TESTS` green
  with the type-error baseline ≤ 36.

**Reconcile with `hr-relay/docs/IOS-PLANS.md`:** that document already records an architecture
decision (2026-11-16): *"walkpadspeed gains a configurable WebSocket heart-rate source … shared
by every platform"*, with the relay gaining a WS endpoint as build step 2. Plans 001/002 choose
HTTP polling instead. These are different topologies (LAN relay vs a phone app serving the page
same-origin), but the app-side should not grow two unrelated network clients. Recommendation:
introduce one small **"HR source" interface** with a common `pushBpm(bpm, meta)` path, implement
the **HTTP poll source first** (simplest, sufficient at 1 Hz, matches plans 001/002), and leave
the WS source as a second implementation behind the same interface for the phone-app topology.
Update `IOS-PLANS.md` to say so, so the decision record is not silently contradicted.

## 6. Action plan (ordered, gated)

1. **Drift & deployment check (no edits).**
   - `git -C ../hr-relay diff --stat 4402df5..HEAD -- main.go README.md main_test.go`
   - `git diff --stat 0ed72f1..HEAD -- walkpadspeed.html test README.md`
   - Confirm the phone is running the build whose `build=` line appears in the trace. Past
     sessions were wasted on a stale deployment (the hosted copy serving an older file), so
     check the `build=` line before trusting any phone-side result.
2. **Capture the app trace for one connect attempt** with `?dbg=1` (or `#debug: 1`), plus
   `journalctl --user -u hr-relay.service --since <t0> -o short-iso | grep -E "client connected|client disconnected|HR [0-9]+ bpm|subscribed|sensor link lost"`.
   Decide H-A vs H-B from §2(a). Record the result in `plans/README.md`; if H-A, open a small
   separate app fix, but do not block the LAN work on it.
3. **Timeboxed direct-COROS re-test (option A)** — one session on the current browser, to confirm
   it is still the broken hop. Record the result. Then stop; do not write new workaround code.
4. **LNA reachability gate on the phone (go/no-go).** Deploy the relay with the HTTP listener
   enabled (plan 001), then from the phone's real origin run a probe page that:
   - queries `navigator.permissions.query({ name: 'local-network' })` in `try/catch`;
   - on a button click, `fetch(url, { headers: { Authorization: 'Bearer …' }, targetAddressSpace: 'local' })`;
   - records the resolved permission state, the HTTP status, the CORS headers, and the exact
     `TypeError`/console error on failure.
   **STOP** if it is blocked and option E is not acceptable. Do not weaken browser security.
5. **Implement plan 001** in `hr-relay` (opt-in authenticated `/api/v1/hr`, mutex-protected
   snapshot, monotonic `sampleSeq`, exact-origin CORS, Go tests), plus the §2(b) log split and
   the §5 advertising switch. Leave the strap-side BLE protocol untouched.
6. **Implement plan 002** in `walkpadspeed.html` with §4 and §5: separate "Connect over Wi-Fi"
   control, `hrTransport` state, one shared BPM helper idempotent on `sampleSeq`, 1 Hz serialized
   polling with `AbortController`, stale clears zone control, token never logged, endpoint
   persisted in `localStorage`.
7. **Verify:** `test/RUN-ALL-TESTS` → `ALL TESTS PASSED` with type errors ≤ 36; inline
   `node --check`; `go test ./...` and `go build -o /tmp/hr-relay .` in `../hr-relay`. Then bump
   the CSS version per `AGENTS.md`, load `auto-commit`, and commit with a lowercase Conventional
   Commit. Do not push.
8. **Phone end-to-end:** connect over Wi-Fi, confirm BPM/zone/speed control; cover the strap →
   stale within 5 s and speed stops adapting; restore → recovery; confirm BLE HR is still
   selectable; confirm the debug log contains no token and no private host.
9. **Docs:** update `walkpadspeed/README.md` (LAN setup with placeholders, LNA permission, stale
   behaviour) and `hr-relay/docs/IOS-PLANS.md` (HTTP poll vs WS reconciliation). No real token,
   host or secret in any doc.

## 7. STOP conditions

- The LNA gate fails on the phone without a secure exact-origin solution → switch to option E;
  never wildcard CORS, never public exposure, never insecure content.
- The live relay API shape differs from plan 001 → reconcile both plans before editing either.
- The app trace shows the 39 s drop is a live-link death (H-B) and the relay's BLE peripheral is
  implicated → fix that first; the LAN path hides the symptom but the relay remains broken for
  every other client.
- LAN support would require changing HR zones, session-log schema, treadmill control or the
  strap's BLE protocol → stop and report.
- Any BLE-HR or Test-Mode regression after two focused attempts → stop and report rather than
  broadening the refactor.

## 8. Open questions for Colas

- Does the app trace for the 39 s event show `HRM notifications on` then `HRM disconnected`
  (H-B, live link died), or `HRM GATT attempt N failed` (H-A, the app gave up)?
- Is the phone's Chrome actually offered the Local Network Access prompt for
  `https://walkpad.fr` → `http://192.168.x.y`? This is the single biggest unknown.
- Is the relay host's LAN address stable (static DHCP lease / mDNS name), or must the app
  support entry of a changing address?
- Should the relay keep advertising BLE when the HTTP listener is on, or stop (my recommendation:
  stop, to stop funneling users into the broken hop)?
- Is wireless adb still paired, for `logcat` if the LNA gate misbehaves?

## 9. Non-goals

No code was changed by this analysis. No private server URL, token or secret appears here. The
strap's BLE protocol, COROS parsing, treadmill control, HR-zone maths and session-log format are
out of scope. The relay's scan-wedge recovery is identified but deliberately left as a separate
task.
