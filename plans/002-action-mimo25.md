# Plan 002 — Analysis & action plan: the phone→relay BLE hop

> **Author**: MiMo-V2.5 (mimo25) · **Date**: 2026-11-20 · **Type**: analysis only (no source files changed)
> **Baseline**: `walkpadspeed` `0ed72f1`, `hr-relay` `4402df5`
> **Companion documents**: `plans/002-action-hy4-flash-free.md` (option matrix + Local Network Access details), `plans/001-hr-relay-lan-api.md`, `plans/002-walkpadspeed-lan-hr-client-gpt6luna.md`, `plans/README.md`

## 1. Short answers to the three questions

1. **"A workaround in the app to use the COROS HRM directly?"** — The app already
   supports it (standard Heart Rate profile since v1.0, hardened through
   v1.1.4-dev.8: wrapper warm-up, first-beat race, phantom-link detection,
   `forget()`). The blocker on the phone is **Chrome 157**, not app code: the
   band's unsolicited vendor notifications NPE Chrome's callback thread and
   `startNotifications()` never resolves (resolved 2026-11-15: nRF Connect and
   Vivaldi work, Chrome/Edge hang). No further app-side workaround has good
   odds. Immediate zero-code option: **use Vivaldi on the phone**. Constraints:
   direct COROS is *mutually exclusive* with the relay (the strap serves one
   central), so it is a fallback that requires stopping the relay — keep it as
   plan-of-last-resort, as concluded in the sibling analysis (option A).
2. **"HTTP to the relay over Wi-Fi?"** — **Yes; this is the primary path.**
   Both machines are on the same LAN. Implement per `001` (protected snapshot
   API in `hr-relay`) then `002` (app client), gated by the README's
   reachability check (Local Network Access / mixed-content: the app must stay
   a secure context because Web Bluetooth for the walkpad requires it, so the
   LAN endpoint is fetched from an https page — see sibling analysis §B for
   `targetAddressSpace: 'local'` and the permission query).
3. **"Raw TCP or UDP?"** — **No.** Page JavaScript has no raw sockets. WebSockets
   (framed over TCP) are possible but buy nothing over HTTP for a 1 Hz snapshot;
   UDP is unreachable from a page. Rejected, as in the sibling analysis (C).

The new contribution of this document is not the option matrix (the sibling
analysis already settles it) but **fresh log evidence about *why* the hop fails,
plus two relay-side problems that must be fixed regardless of which transport we
choose.**

## 2. What the logs actually show (new evidence)

### 2.1 The 39 s drop is phone-side; the strap→relay leg was healthy

`journalctl --user -u hr-relay.service` for 2026-11-19 (the day of the report):

- Phone connections that died short (12 of 18 closed connections across
  11-16…11-19 lasted < 120 s). On 11-19 specifically: 39 s, 39 s, 58 s, 38 s,
  58 s, 25 s, 58 s at 13:26–13:35, and 39 s at 20:20:52→20:21:31. Each shows
  `client connected: <phone RPA>` then `client disconnected … (disconnected)`
  with **no error** on the link.
- **HR kept flowing during those windows**: 7 `HR … bpm` lines inside
  13:26:35→13:27:14 and 11 inside 20:20:52→20:21:31. So the COROS strap and the
  relay were fine; the drop is between the phone's radio/Chrome and the relay.
- The phone uses a fresh random address each attempt (56:F0:EB…, 5F:3B:9F…,
  66:D3:4B…), i.e. repeated *new* connect attempts, not one link flapping.
- The hop is **intermittent, not always broken**: 6 connections lasted ≥ 120 s
  (max 5 h 21 m, 2 h 27 m, 1 h 06 m, 59 m, 44 m). Phone connects per day:
  11-16: 3, 11-17: 5, 11-18: 2, 11-19: 8, 11-20: 0. HR lines per day:
  772 / 384 / 361 / 286 / **0**.
- **No code changed between 11-17 and 11-19** (walkpadspeed `0ed72f1` of 11-17,
  hr-relay `4402df5` of 11-16) — the 39 s failures are environmental, not a
  regression from recent edits.

**About the figure 39 s**: it is suspiciously close to the app's
`HRM_CONNECT_BUDGET_MS = 40000` (`walkpadspeed.html:1892`), after which
`openHrmGatt()` stops starting attempts and gives up. But note the relay logged
a *BLE-level* disconnect (an actual link drop, reason `(disconnected)`) at 39 s
while HR kept flowing — an app-side give-up does not by itself drop an
established ACL, so two candidates remain: (a) the phone's stack/Chrome dropped
the link and the app merely noticed, or (b) the app's failure path closed it.
The `?dbg=1` trace distinguishes them: budget expiry shows as
`HRM GATT attempt N failed` lines then a final failure status at ~40 s, whereas
a live-link death shows `HRM disconnected` / a `gattserverdisconnected` event
with the attempts still mid-flight. **Capture one trace before concluding.**

### 2.2 The relay itself is currently wedged (blocks all testing)

Live state as of 2026-11-20 ~10:00:

- Process PID 3545718 alive since **11-16 19:20:32** (`Restart=always`,
  `WatchdogUSec=0` — a *hung* process never crashes, so systemd never restarts it).
- Last journal line: `2026-11-20 07:33:22 scanning for sensor (D1:F9:A6:A2:FC:6D)...`
  — **then ~2.5 h of silence**, no HR today (0 lines vs 286 yesterday), 0 phone
  connects today.
- `busctl get-property org.bluez /org/bluez/hci0 org.bluez.Adapter1 Discovering`
  → `true`, stuck.
- Root cause chain: nightly suspend `01:35:02` → resume `07:33:17` (kernel
  `PM: suspend entry/exit` markers) → one transient D-Bus error at 07:33:17 →
  `Scan()` started at 07:33:22 and **never returns**. In `hr-relay/main.go:141-163`
  the 15 s "not advertising" timeout sits in a `select` *after*
  `adapter.Scan()` returns, and `tinygo.org/x/bluetooth` `Scan()` blocks until
  `StopScan()` — which only happens from the scan callback when the strap is
  matched. If no matching result ever arrives, **the timeout can never fire**:
  the relay hangs forever inside `Scan()` with `Discovering` stuck true.
- Before that, since **11-19 13:38:58** the relay logged
  `sensor not available: scan: Operation already in progress — retrying in 5s`
  every 5 s (≈720/hour through the night, first ever occurrence 11-19 13:38:58)
  — BlueZ already had a discovery session (its own leaked one, or blueman's).
  The storm only cleared at the 07:33 resume.

**Actions (ops, no code):**
1. `systemctl --user restart hr-relay.service` now, then verify
   `Discovering` goes false, `advertising as …` appears, and HR lines resume
   once the strap is worn/advertising. If `Discovering` stays true after the
   restart, the holder is elsewhere (blueman) — stop blueman or clear the
   discovery session, then re-check.
2. Fix the scan timeout in `hr-relay` (run the 15 s timeout *concurrently* with
   `Scan()`, calling `adapter.StopScan()` from the timer goroutine) so a silent
   strap can never hang the relay again. This is a small, isolated change to
   `connectSensor()`.

### 2.3 The resume-watch never fires — nightly suspend bypasses logind

- The nightly suspend is a **root cron** line `35 01 * * * suspend-force only-idle`
  which suspends by writing `mem` to `/sys/power/state` **directly**, bypassing
  logind — so `PrepareForSleep` is never emitted and
  `hr-relay-resume-watch.service` (a `dbus-monitor` on that signal) never
  triggers. Kernel markers confirm suspend/resume every night 11-17…11-20 while
  the watch's journal shows **no "resume detected" on any of those days** (the
  single 11-16 18:43:14 entry followed a watch-service restart 1 s earlier —
  buffered/spurious, not a real resume).
- Also dead: `manual-suspend.timer` is a dangling symlink (target file missing;
  `systemctl list-timers manual-suspend.timer` → 0 timers) and the hourly
  variant is commented out in the root crontab.
- Consequence: after every nightly suspend the relay's BLE advertisement and
  scan state are never restored — this is very likely how it ended up in the
  wedged state of §2.2.

**Action:** make the watch logind-independent — restart the relay on the kernel
journal's `PM: suspend exit` (e.g. a `journalctl -k -f` watcher or a systemd
path/timer unit on that marker), or hook the root cron to a
`suspend.target.wants` unit that runs after resume. Keep the existing
logind-based watch as a second trigger, don't rely on it alone.

### 2.4 Consequence for the plan sequence

The relay must be healthy for plan 001 to be testable at all, and the phone's
BLE hop must be considered unreliable **in both directions of diagnosis**: even
with a healthy relay, the phone dropped the link 12/18 times. That strengthens
the case for the HTTP LAN path (plans 001 → 002) as the *primary* feed and
relegates both BLE paths (relay-hop and direct-COROS) to fallback.

## 3. Ordered action plan

| # | Action | Repo / where | Why now |
|---|--------|--------------|---------|
| 1 | Restart `hr-relay.service`, verify advertisement + `Discovering` false + HR resumes; stop blueman if the discovery storm persists | ops | Nothing can be tested while the relay is hung (§2.2) |
| 2 | Fix `connectSensor()` scan timeout to run concurrently with `Scan()` (StopScan from a timer) | `hr-relay` | Removes the hang-forever failure mode permanently |
| 3 | Make the resume-watch trigger on kernel `PM: suspend exit` (logind bypass) | ops/systemd | Resume handling currently never runs (§2.3) |
| 4 | Capture one `?dbg=1` connect trace on the phone to classify the 39 s drop (budget expiry vs live-link death) | app, read-only | Decides whether any app-side change is even worth proposing (§2.1) |
| 5 | Implement plan `001`: protected LAN HR snapshot API in `hr-relay` | `hr-relay` | Primary feed; depends on 1–3 for a healthy server |
| 6 | Reachability gate: from the phone's secure app origin, fetch the 001 endpoint (Local Network Access permission, `targetAddressSpace: 'local'`) | test | README hard gate — do not weaken browser security; if it fails, pick a secure endpoint topology first (sibling §B/§D) |
| 7 | Implement plan `002`: app consumes LAN snapshots as primary HR source, BLE as fallback | walkpadspeed | Deliverable of this brainstorm |
| 8 | Fallback A (direct COROS): document "use Vivaldi on the phone" as the zero-code workaround; keep direct-COROS code path as-is | docs | Chrome 157 is the blocker, not app code (§1.1) |

Sequencing note: 1–3 are prerequisites for testing 5–7 (a wedged relay serves
no snapshot); 4 can run in parallel with 1–3 and gates whether any app HRM code
changes are proposed at all. The sibling analysis (`002-action-hy4-flash-free.md`)
already rejected raw TCP/UDP and native bridges; this plan does not reopen those.

## 4. What this document does not do

- No source files changed (analysis only, mirroring the sibling action file).
- No claims beyond the logs: the 39 s ≈ `HRM_CONNECT_BUDGET_MS` correlation is
  explicitly a *candidate* pending the `?dbg=1` trace (§2.1).
- No private server URLs, tokens or secrets are referenced.
