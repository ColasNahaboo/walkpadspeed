# Plan 002 — Analysis & action plan: escaping the phone-to-relay BLE hop

> **Author**: Hy4 flash Free · **Date**: 2026-11-20 · **Type**: analysis only (no source files changed)
> **Baseline**: `walkpadspeed` `0ed72f1`, `hr-relay` `4402df5`
> **Companion documents**: `plans/001-hr-relay-lan-api.md`, `plans/002-walkpadspeed-lan-hr-client-gpt6luna.md`, `plans/README.md`

## 1. Short answers to the three questions

1. **"Can the app work around this and talk to the COROS strap directly?"** — Technically it already can: the app has spoken standard Heart Rate service (`0x180D` / `0x2A37`) since v1.0. But the direct path is exactly the hop that failed on the phone (Chrome 157 regression: unsolicited vendor notifications wedge Chrome's callback thread, the CCCD write is never acknowledged, `startNotifications()` never resolves). The app is already hardened for this (optional-services wrapper warm-up, first-beat race, phantom-link detection, `forget()`, reload hint). A *new* app-only workaround is low-probability, and direct COROS is mutually exclusive with the relay (the strap serves one central). Keep direct COROS as a fallback, not as the fix.
2. **"Can a connection to the relay over Wi-Fi work?"** — Yes, and **HTTP is the right transport**. Raw TCP/UDP is impossible from page JavaScript; WebTransport is overkill for a 1 Hz BPM value. The protected LAN JSON API in plan 001 + the client in plan 002 are the correct shape. One important 2026 detail the existing plans do not spell out: from an HTTPS page, an `http://` LAN request needs Local Network Access handling — `targetAddressSpace: 'local'` on the `Request`, a permission query, and a user gesture. With that, Chrome 145+ (so the phone's Chrome 157) can make it work without weakening browser security.
3. **"Why did the app disconnect after 39 s while the relay kept emitting?"** — Unknown until logs are correlated. The relay's `HR … bpm` lines prove the **strap → relay** leg was alive; they say nothing about delivery to the phone. Diagnose which side dropped the link *before* choosing the fix, but note that **all four plausible causes are either solved by the LAN client or unaffected by it**, so the LAN work is not blocked on this diagnosis.

**Recommendation**: proceed with plans 001 + 002 as the primary direction, amended with the LNA details in §4, and run a short log-correlation exercise in parallel to explain the 39 s disconnect. Do not invest in a new direct-COROS workaround or a nativephone bridge.

## 2. Evidence and what it does / does not prove

- The relay is a BLE central to the strap and a BLE peripheral to the phone. Its `HR %d bpm` lines are emitted in `onSensorData()` while handling **source** notifications; they are written before (and independently of) `r.hrm.Write(data)` to the phone. "The relay emitted" ≠ "the phone received".
- The app's connect path is already deeply defensive: `HRM_CONNECT_ATTEMPTS = 3`, `HRM_CONNECT_BUDGET_MS = 40000`, per-op 10 s timeouts, same-link CCCD retry, phantom-link cooldown + `forget()`, first-beat watchdog, and a `gattserverdisconnected` handler that zeroes `currentHeartRate` and updates the UI.
- The history in `AGENTS.md` (2026-11-13 → 11-15) tried: re-ordering characteristics, `optionalServices`, full service/characteristic warm-up, first-beat race, phantom-link handling. Final finding: a **Chrome 157 regression**; Vivaldi connects after retries. That is a browser-layer defect page JS cannot repair.
- 39 s is close to `HRM_CONNECT_BUDGET_MS` (40 s). It is worth checking whether the log describes a *live link that died at 39 s* or a *connect sequence that ran out of budget* — these need different fixes.

## 3. Option matrix

| Option | Feasible from the page? | Effort | Risk / downside | Verdict |
|---|---|---|---|---|
| **A. Direct COROS BLE from the app** (new workaround) | Yes, existing code path | Low to try, high to make reliable | Chrome 157 defect; single-central conflict with relay; loses the known-good Linux/other-browser path | Fallback only. One quick re-test on the current browser build, then stop. |
| **B. HTTP GET to relay over LAN** (plans 001+002) | Yes — `fetch` + LNA | Medium (two repos, tests) | Requires phone reachability gate; bearer-token hygiene; stale-data handling | **Primary recommendation.** |
| **C. Raw TCP or UDP from the page** | **No** — ordinary browser JS has no raw sockets. WebTransport datagrams need HTTPS/QUIC + a server that speaks them | High | Wrong tool for one integer per second | Reject. |
| **D. Same-origin HTTPS proxy** on the existing app origin, forwarding to relay over the LAN | Yes (no cross-origin fetch, no LNA prompt) | Medium (server-side config outside these two repos) | Needs operator/server access; a new component to maintain | **Fallback if B's gate fails** — design separately, do not weaken CORS to force B. |
| **E. Native phone bridge app** (raw socket → localhost HTTP) | n/a | High | Breaks the single-file app model, distribution, permissions | Reject. |
| **F. Keep BLE relay, harden reconnect only** | Yes | Low | Does not address a phone stack that drops the link after ~39 s; repeated taps wedge Chrome's GATT queue | Not sufficient alone; keep BLE as a secondary path. |

WebSocket/SSE (push) can both work and are also subject to LNA, but a 1 Hz poll is simpler to test and debug. Revisit only if measured latency/overhead demands it.

## 4. Important correction to plan 002 step 1 (2026 browser behaviour)

Current best-practice guidance for Local Network Access (Chrome/Edge 145+):

- The app **must** be served from a secure context; LNA is denied in insecure top-level contexts (already true — Web Bluetooth requires this too).
- For an `https://` page fetching `http://` on a private LAN address, set `targetAddressSpace: 'local'` on the `Request`/`fetch` options. This both (a) exempts the request from Mixed Content blocking once permission is granted and (b) makes the browser verify the resolved IP really is local.
- Query `navigator.permissions.query({ name: 'local-network' })` in a `try/catch`; treat `'prompt'` by explaining the need and issuing the **first** request from the explicit "Connect over Wi-Fi" button click, render remediation UI for `'denied'`, and listen for `change`.
- **Never** query the legacy combined name `'local-network-access'` — it can crash older Chrome renderers.
- Feature-detect: Firefox/Safari lack LNA; handle `TypeError` from `permissions.query` as `'prompt'` and show a clear failure message if the fetch is blocked.
- Keep relay-side CORS exact-origin + bearer token (plan 001); do not add deprecated PNA preflight headers, wildcard CORS, or credentials.

Consequence: plan 002 step 1's reachability probe must be run with these exact mechanics, not a bare `fetch()`. If it still fails, mark BLOCKED and design option D (same-origin HTTPS proxy) — do not relax browser protections.

## 5. Which cause explains the 39 s disconnect — and why it does not block the LAN work

| Hypothesis | What would confirm it | Does the LAN client fix it? |
|---|---|---|
| **H1** — phone Chrome drops the GATT link (Doze/background tab/157 NPE race) | App trace shows `HRM notifications on` then `HRM disconnected` ~39 s later; relay log shows its peripheral client disappearing | **Yes** — no BLE central role on the phone for HR |
| **H2** — relay drops the phone client (TinyGo peripheral handling, resume-watch restart, advertising reset) | Relay journal shows its connected client dropping/restarting at the same second | **Yes** — phone no longer connects to the relay over BLE; relay's BLE peripheral role becomes irrelevant to the app. Worth a separate relay fix later. |
| **H3** — our own app tears the link down | `?dbg=1` trace shows `hrmFailCount`, a view switch, or `disconnectHRM()` near t=39 s; 39 s ≈ the 40 s connect budget | Yes as a side effect; also fix the app bug independently |
| **H4** — strap → relay leg actually dropped | Relay journal stops logging `HR … bpm` at t=39 s (contradicts the report) | Not fixed by LAN — but plan 001's API reports `sensorConnected`/`sampleAgeMs`, so the app would at least *see* it instead of silently losing BPM |

**Diagnostic (do this first, ~15 min)**: align timestamps from (a) the app's debug trace — include the `build=` line to confirm the deployed version, (b) `journalctl --user -u hr-relay.service -n 200 -o cat`, and (c) phone `logcat` if wireless adb is still paired. Record which side sent the disconnect. If H2/H4, note it for a later relay task; do not expand this plan's scope.

## 6. Action plan (ordered, with gates)

1. **Drift & version check (no edits).**
   - `git diff --stat 0ed72f1..HEAD -- walkpadspeed.html test README.md` and `git -C ../hr-relay diff --stat 4402df5..HEAD -- main.go README.md main_test.go`.
   - Confirm the phone actually runs the build whose `build=` line is in the trace (past sessions wasted time on a stale deployment).
2. **Diagnose the 39 s event** (§5). If H3 (an app bug), open a small separate fix; otherwise proceed. Record the finding in `plans/README.md` notes.
3. **Re-test direct COROS once, briefly (option A)** with the current browser and the app's existing hardening, to confirm it is still the broken hop. Do not add new workaround code. Timebox: one session.
4. **Re-run the phone reachability gate with LNA mechanics (§4)** before any UI work: exact HTTPS origin + LAN endpoint, `targetAddressSpace: 'local'`, permission query from a click, CORS preflight, fresh JSON. **STOP** if blocked; design option D and report the exact browser error.
5. **Implement plan 001** in `hr-relay` (opt-in authenticated `/api/v1/hr`, mutex-protected snapshot, monotonic `sampleSeq`, exact-origin CORS, Go tests). Keep the relay's strap-side BLE code untouched.
6. **Implement plan 002** in `walkpadspeed.html` with the §4 LNA details:
   - Separate "Connect over Wi-Fi" control on the Connections view; never repurpose `#connectHrmBtn`.
   - Extract one BPM-processing helper shared by BLE, LAN and Test Mode; dedupe on `sampleSeq`.
   - Explicit HR transport state (`null` / `ble` / `lan` / `test`) + freshness predicate; update the non-BLE `hrmCharacteristic` guards; keep BLE-only uses of the characteristic object as-is.
   - Serialized 1 Hz polling with `AbortController`; stale (`sampleAgeMs > 5000`, `sensorConnected === false`, null BPM) clears the active BPM used by zone control and logging; LAN network errors must not feed `hrmFailCount`.
   - Token is session-only, never echoed in status/debug/URL; no private host or token in README/code comments.
7. **Verify**: `test/hrm-lan.test.cjs` (new); `test/RUN-ALL-TESTS` → `ALL TESTS PASSED` with type-error count ≤ 36; inline `node --check`; `go test ./...` in `../hr-relay`. Then bump CSS version per `AGENTS.md`, load `auto-commit`, and commit with a lowercase Conventional Commit message. Do not push.
8. **Phone end-to-end**: connect over Wi-Fi, confirm BPM/zone/control, cover the strap → stale within 5 s and speed stops adapting, restore → recovery; confirm BLE HR still selectable and one transport's disconnect does not mark the other connected; confirm the debug log contains no token.

## 7. STOP conditions / open questions

- Stop plan 002 if the LNA gate fails without a secure, exact-origin solution — switch to option D, never wildcard CORS or public exposure.
- Stop if the live API shape differs from plan 001; reconcile both plans first.
- Stop if LAN support would require changing HR zones, session-log schema, treadmill control or the strap's BLE protocol.
- Stop after two focused attempts at any BLE/Test-Mode regression; report rather than broadening the refactor.
- Questions for Colas: (a) is the app's HTTPS origin under your control (needed for option D if the gate fails)? (b) does the 39 s trace correspond to a link dying or to the connect budget expiring? (c) is wireless adb still paired for `logcat` capture?

## 8. Non-goals

No code was changed by this analysis. No private server URL, token, or secret appears in this document. The relay's strap-side BLE behaviour, COROS parsing, treadmill control, and session-log format are out of scope.
