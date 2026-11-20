# Plan 002 — Analysis & action plan: kill the phone→relay BLE hop (mine, verified)

> **Author**: qwen3.8-flash-next · **Date**: 2026-11-20 · **Type**: analysis + action plan
> **Baseline**: `walkpadspeed` `0ed72f1` (v1.2.0-dev.6), `hr-relay` `4402df5`
> **Companions**: `plans/001-hr-relay-lan-api.md`, the six other `plans/002-action-*.md`

## 1. Answers to the three questions

1. **Direct COROS workaround in the app?** No. The app already speaks the standard
   `0x180D`/`0x2A37` path; it is broken by the Chrome 157 Blink defect
   (`docs/bugreport-google-chrome-v157.md`), every page-side mitigation is already in
   `openHrmGatt()`, the characteristic is notify-only (no `readValue()` polling escape),
   and the strap serves one central — direct use evicts the relay. Keep as fallback only.
2. **Wi-Fi to the relay?** Yes — HTTP GET polling of a protected `/api/v1/hr` at 1 Hz.
   Raw TCP/UDP is impossible from page JS; WebTransport/WebSocket are overkill at 1 Hz.
   The go/no-go is Chrome's Local Network Access gate from the real HTTPS origin on the
   phone (see §4).
3. **The 39 s disconnect?** I re-pulled the journal myself (below). It is the
   **phone→relay ACL dying or being torn down**, not the relay stopping: the relay
   forwarded `HR 82→78 bpm` continuously across the drop and never logged a forward
   error. The app has **no auto-reconnect**, so one drop costs the whole session —
   that gap is real and fixable independently of the transport.

## 2. Verified evidence (checked live today, not from memory)

`journalctl --user -u hr-relay.service` for 2026-11-19 13:24–13:35:

```
13:26:35 client connected: 56:F0:EB:…  → 13:27:14 disconnected  (39 s)
13:27:45 client connected: 5F:3B:9F:…  → 13:28:24 disconnected  (39 s)
13:28:59 client connected: 66:D3:4B:…  → 13:29:57 disconnected  (58 s)
13:30:13 client connected: 75:94:7D:…  → 13:30:51 disconnected  (38 s)
13:31:31 client connected: 71:D2:ED:…  → 13:32:29 disconnected  (58 s)
13:33:47 client connected: 5F:E7:EF:…  → 13:34:12 disconnected  (25 s)
```

Six phone attempts (rotating Android random MACs), every one dropped, `HR … bpm`
never interrupted, zero `forwarding to clients failed` lines. The 20:20 event shows
the same signature: one ACL up, HR forwarded for 39 s, `client disconnected`, HR
keeps flowing.

What this rules in/out:

- **Not the strap→relay leg** — it streamed through every drop.
- **Not exactly the app's 40 s connect budget** — the spread is 25–58 s. A pure
  budget expiry would cluster at ~40 s (and the 25 s drop is below any attempt
  sequence: attempt 1 ≈ 15 s + backoff + attempt 2 ≈ 15 s → earliest give-up ≈ 31 s).
  So: a mix of live-link deaths (phone stack / relay peripheral side) and possibly
  user-initiated disconnects — `disconnectHRM()` writes no trace line today, which
  is itself a gap.
- **The relay's log cannot tell ACL from GATT subscription** — `main.go:253-271`
  logs the relay's *own central link to the strap* (`D1:F9:…`) with the same
  `client connected:` line shape as a phone. This is why "relay emitted but app
  never connected" is unresolvable from the journal alone.
- **The relay's central leg is structurally fragile**: today's journal has 1140 ×
  `scan: Operation already in progress` and a ~6 h silent gap ending 07:33 — the
  retry loop blocks inside a non-cancellable `adapter.Scan` (`main.go:141-163`:
  timeout path calls `StopScan()` from outside; the old `Scan` never returns; next
  `Scan` fails forever). Every link loss re-enters this race. The LAN API is only
  as good as this leg, so it must be fixed first.

## 3. Meta-review of the other six plans

| Plan | Verdict |
|---|---|
| **deepseek-v4.1-flash-free** | **Best of the seven.** Only plan that (a) pulled the journal *and* found the 6 h stall + scan-race mechanism, (b) caught the `sampleSeq`-resets-on-restart trap (needs `relayId`), (c) caught the `loopback` vs `local` `targetAddressSpace` trap that would break the Playwright test, (d) caught that `targetAddressSpace` breaks the tsc ≤36 baseline unless cast, (e) proposed app auto-reconnect (P1) — the one fix that helps *today*, and (f) correctly refuted longcat's "clear `hrmStepTargetZone` on stale" (that permanently disarms zone control; the `currentHeartRate <= 0` guard is the right gate). Option E (serve app+API same-origin from the relay) is a genuinely better topology if the LNA gate is awkward. Adopting most of it. |
| **longcat-2.5-free** | Second best: actually pulled the journal (the 39 s table, the strap-ACL log confusion, today's wedge). Its stale-handling advice to clear `hrmStepTargetZone` is wrong (see above). The `-advertise=false` when HTTP is on is a good UX call. |
| **qwen3.8-27b-text-q8-131k-nv** | Solid executor plan; correctly verified plan 001 is *not implemented* (true — no HTTP code in `main.go`); ranked the 40 s budget as top hypothesis, which my 25–58 s spread weakens but does not exclude. No new evidence. |
| **hy4-flash-free** | Correct LNA amendment, honest "unknown until logs correlated" on the 39 s. Redundant with the above; no journal check. |
| **qwen36** | Competent architecture, zero evidence-gathering (didn't touch the journal, didn't check plan 001's state). Its H3 "39 s ≈ budget" is plausible but unverified. Fine skeleton, weak analysis. |
| **nemotron35** | Near-verbatim copy of qwen36 (same sections, same phrasing) with code snippets added. One real bug: it feature-detects LNA via `permissions.query({name:'local-network-access'})` — the exact legacy name the other plans warn can crash older Chrome renderers. Do not follow its snippet. |
| **gpt6luna** (the plan under review) | Good executor scaffolding (drift check, STOP conditions, done criteria) but written before the LNA mechanics were known; the hy4/longcat/deepseek amendments supersede its step 1. |

**Pattern**: the plans that ran commands beat the plans that reasoned from the
prompt. Three of seven never opened the journal or the relay repo; two of those
three are near-duplicates of each other. For future panels: fewer, evidence-checking
models (see §7).

## 4. Decision

Adopt the consensus (plans 001 + 002, HTTP poll, transport abstraction) with the
deepseek/longcat amendments, ordered so that each phase is independently valuable:

- **P0 (relay, independent, do first)**: single long-lived scan loop (one
  `adapter.Scan` per process, advertisements → buffered channel; deletes the
  `Operation already in progress` race), progress watchdog → `log.Fatal` → systemd
  restart, `-stale-secs` 60 → 300, log strap-ACL vs phone-ACL distinctly, count
  `hrm.Write()` failures.
- **P1 (app, independent, quick win)**: HRM auto-reconnect on `gattserverdisconnected`
  (≤3 tries, 2/4/8 s, only when not user-disconnected; separate counter from
  `hrmFailCount`), `trace('HRM user disconnect')` in `disconnectHRM()`, retry on
  `visibilitychange`. This alone would have saved the 2026-11-19 session.
- **P2 (relay)**: plan 001's `GET /api/v1/hr` + `relayId` (random per process —
  mandatory, else a restart freezes the app's `sampleSeq` dedupe forever),
  `version`, `forwardErrors`, `lastForwardOkMs`, `sensorConnected` = subscription
  state, `sampleAgeMs` null until first sample; exact-origin CORS +
  `Access-Control-Max-Age: 600`, constant-time token compare, opt-in LAN bind.
- **P3 (app)**: LAN client — `hrTransport` (`null|ble|lan|test`), shared
  `processHrSample()` (idempotent on `(relayId, sampleSeq)`), `hrmConnected()`
  freshness predicate, serialized 1 Hz `setTimeout` poll + `AbortController`,
  stale (`sampleAgeMs>5000` / `sensorConnected:false` / null bpm / frozen seq) →
  `currentHeartRate=0` + `resetHrTrend()` but **keep `hrmStepTargetZone` armed**,
  `addressSpaceFor(host)` (`'loopback'` for localhost — the test must not send
  `'local'` to a loopback mock), cast the `targetAddressSpace` init to keep the
  tsc baseline at 36, guard-site table from deepseek §7.1, token session-only and
  never in trace/status/README.
- **P4 (gate before P3 ships)**: 10-minute phone probe from the real HTTPS origin
  with `targetAddressSpace` + permission query. If blocked → option E (relay serves
  app + API same-origin over HTTPS, ACME DNS-01 cert) instead of weakening anything.

## 5. Execution order for me (implementation phase)

1. `hr-relay` P0 (Go, `go test ./...` + `go build`), deploy via
   `go build -o hr-relay . && systemctl --user restart hr-relay`.
2. `walkpadspeed.html` P1 (auto-reconnect + trace truth) — `node --check`,
   `test/RUN-ALL-TESTS`, version bump, commit.
3. `hr-relay` P2 (HTTP API + tests).
4. `walkpadspeed.html` P3 + `test/hrm-lan.test.cjs` + README, version bump, commit.
5. Colas runs the P4 phone gate + end-to-end (fresh/stale/recovery, no token in
   debug log, BLE path still selectable).

## 6. STOP conditions

- LNA gate fails on the phone and option E is unacceptable → stop, report, never
  weaken CORS/mixed-content.
- Live API shape diverges from plan 001 → reconcile both repos' plans first.
- Any BLE-HR or Test-Mode regression surviving two focused attempts → stop.
- No private host/token in any user-visible text, ever.

## 7. Panel recommendation (asked by Colas)

For this kind of multi-model planning review, my shortlist:

1. **deepseek-v4.1-flash-free** — the only one that went to the primary evidence
   and found design traps others missed. Keep as the anchor.
2. **longcat-2.5-free** — also evidence-driven, complementary angle (relay-side
   gaps). Keep.
3. **qwen3.8-27b-nv** — verified the dependency state (plan 001 unimplemented);
   good cheap checker, and it's local (free, fast). Keep.

Drop: **qwen36** and **nemotron35** (near-duplicates, zero verification, one
outright bug), **hy4** (correct but fully redundant). Three evidence-checking
models beat six reasoning-from-prompt ones; diversity of method matters more than
count. Rule of thumb: include only models whose output I could not predict from
the prompt alone.

On **qwen3.6-35b-a3b-mtp-nv** as a sub-agent workhorse: yes for *mechanical*
sub-agent tasks — explorer-style codebase search, running/summarizing tests,
boilerplate edits, first-pass drafts — where 3 B active params and local latency
are a net win and errors are caught by the build/tests. No for root-cause
analysis, cross-repo design, or security-sensitive planning: the qwen36-family
output in this very panel was the shallowest of the seven (no journal check,
copy-paste architecture, a real LNA feature-detection bug). Delegate work whose
correctness a compiler or test can check; keep judgment work for yourself.
