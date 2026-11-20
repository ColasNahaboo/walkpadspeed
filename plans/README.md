# Implementation Plans

Generated 2026-11-20 for replacing the unreliable phone-to-relay BLE leg with
a local-network HR feed. The implementation spans this repository and its
sibling `hr-relay` repository. Run the plans in order; plan 002 depends on plan
001 and its Android-browser reachability check.

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 001 | Expose a protected LAN HR snapshot API in `hr-relay` | P1 | M | — | IN PROGRESS (code done `9b60b90`, tests green; phone reachability gate pending — needs `-http`/`-http-origin`/token config) |
| 002 | Consume LAN HR snapshots in walkpadspeed | P1 | M | 001 | IN PROGRESS (code done `f11d820`, 24-check Playwright suite green; end-to-end on the phone pending plan 001's gate) |

Also done out-of-band (2026-11-20): relay scan-loop wedge fix + watchdog + log
split (`hr-relay 3154391`, deployed), app HRM auto-reconnect
(`walkpadspeed e9239c9`).

Status values: `TODO`, `IN PROGRESS`, `DONE`, `BLOCKED` (with one-line reason),
or `REJECTED` (with one-line rationale).

## Dependency notes

- Plan 002 must not start its app integration until the phone's actual secure
  app origin can fetch the relay endpoint over the LAN. If browser local-network
  or mixed-content restrictions block it, stop and choose a secure endpoint
  topology first; do not weaken browser security.

## Verified findings (2026-11-20, from `journalctl --user -u hr-relay.service`)

- The 39 s drop is the phone→relay ACL dying (spread 25–58 s over six attempts on
  2026-11-19), not the relay stopping: `HR … bpm` streamed through every drop and
  no forward error was ever logged. The app has no HRM auto-reconnect, so one drop
  costs the session (fix independently of the transport).
- The relay's central leg is fragile: 1140 × `scan: Operation already in progress`
  plus a ~6 h stall on 2026-11-20 — the retry loop blocks inside a non-cancellable
  `adapter.Scan` (`main.go:141-163`). Fix before relying on the LAN API.
- The relay log conflates the strap ACL and phone ACLs as `client connected:` —
  split them so the next incident is diagnosable.
- `sampleSeq` resets on relay restart → the API must carry a per-process `relayId`.

## Findings considered and rejected

- **Raw TCP/UDP from the page:** ordinary browser JavaScript cannot open raw
  sockets. WebTransport datagrams are not warranted for a one-Hz BPM feed.
- **Direct COROS as the primary fallback:** the app already supports the
  standard Heart Rate service, but the direct COROS path has known Android
  Chromium notification failures and competes with the relay for the strap's
  single-central connection.
- **WebSocket/SSE for the first version:** both can work, but one HTTP JSON
  poll per second is simpler to test and more than sufficient for HR updates.
  Revisit only if polling proves inadequate.
