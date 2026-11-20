## walkpadspeed — Project & Session Summary

### What the project is

`walkpadspeed` is a **single-file HTML web app** (`walkpadspeed.html`) for controlling Bluetooth walking pads and treadmills via the Web Bluetooth FTMS protocol. It lives at [github.com/ColasNahaboo/walkpadspeed](https://github.com/ColasNahaboo/walkpadspeed). There is no build system, no framework, no server — everything is one self-contained HTML file with inline CSS and JS. The current version is **v1.1.1**.

**Hardware**: per-pad field notes (Fousae ZX-390, Merach UltraWalk W60, and how to
capture a new one) live in [`docs/HARDWARE.md`](docs/HARDWARE.md). Read it before
touching the data-frame parsing, the speed cap or the control-point handshake.

---

### Architecture overview

**Two views** share the same page, toggled by URL params:

- **Manager view** — loads a plain-text routines file (drag-drop, file picker, or GitHub Gist URL), parses it, and displays each routine as a clickable button. Each button encodes the full routine in its URL so it can be bookmarked or shared.
- **Player (Driver) view** — connects to the walkpad via BLE FTMS, runs the selected routine, shows live metrics, and drives speed/incline changes on a timer.

**State persistence**: routines file is cached in `localStorage` (`wpss_cached_routines`). Session log also persists in `localStorage` (`wpss_session_log`). URL params carry the active routine's packed step data.

---

### Routines file format

Plain `.txt` file. Key features implemented during this session:

```
# metadata lines
#name: Colas
#birth: 1975              # computes metaAge = currentYear - birthYear
#weight: 75
#rest-heart-rate: 55
#max-heart-rate: 180
#speed-unit: mph          # file-wide mph default for all speeds
#incline: 6               # fixed treadmill incline, applied at start and shown like a step token
#max-speed: 8             # fallback pad max-speed cap when BLE 0x2AD4/0x2AD1 is absent or implausible (default 12)
#min-speed: 0.5           # fallback pad min-speed floor when BLE 0x2AD4/0x2AD1 is absent or implausible (default 1.0)
#version: 1

# routine block (blank line separates routines)
Morning Walk
3.0 5m Warmup             # speed duration[m/mn/s] [label]
4.5/Z2 20m Aerobic        # speed/Zn = zone-targeted speed
5.0mph 2m Sprint          # mph suffix (per-step override)
3.0 60 Cooldown

HIIT
// comments after // are stripped
```

**Step line token rules:**
- Speed: plain km/h, `Xmph` (converted to km/h on parse), or `X/Zn` (zone-targeted — see below)
- Incline: optional `X%` token between speed and duration
- Duration: seconds, or `Xm`/`Xmn` for minutes (normalized to seconds internally; displayed as `Xm` if round)
- Label: remaining tokens, joined with `_` in packed format

**Packed step format** (in URL): `speed[Zn]-[incline%_]duration[-label]`, comma-separated. E.g. `4.5Z2-6%_1200-Aerobic`.

---

### Metadata globals (set by `parseMetadata(text)`)

`metaName`, `metaBirthYear`, `metaAge` (derived from `#birth:`; feeds the `220 - age` max-HR default), `metaWeight`, `metaRestHeartRate`, `metaMaxHeartRate`, `metaSpeedUnit`, `metaFileVersion`, `metaIncline`, `metaMaxSpeed` (optional cap when neither BLE speed-range characteristic is readable; default 12), `metaMinSpeed` (optional floor when the pad's BLE min is unreadable; default null), `metaHRM` (set to 0 by `#hrm: 0` to hide the HR metric UI; default 1), `metaStepLength` (step length in meters at 3 km/h; default 0.62)

`parseMetadata` is called both in the manager (on file load) and in `initDriverMode` (re-parses from `localStorage` cache since page navigation resets JS globals).

**Speed-cap globals**: `bleMinSpeed`, `bleMaxSpeed`, `bleMinIncrement` (km/h, read from FTMS Supported Speed Range characteristic `0x2AD4`, falling back to the deprecated `0x2AD1`, on connect — see "Pad max-speed cap" below; `bleMinSpeed`/`bleMinIncrement` are stored but not yet used); `metaMaxSpeed` (file override); `maxSpeedLimit` (effective cap, resolved by `updateMaxSpeedLimit()` from BLE value → file override → `DEFAULT_MAX_SPEED = 12`).

---

### HR Zone system

Uses **Karvonen / Heart Rate Reserve** method. Requires `#rest-heart-rate` and `#max-heart-rate` in the routines file.

```javascript
const ZONE_BOUNDARIES = {
    0: [0.38, 0.43],   // Z0  digestive    purple
    1: [0.50, 0.60],   // Z1  recovery     blue
    2: [0.60, 0.70],   // Z2  aerobic      green
    3: [0.70, 0.80],   // Z3  endurance    yellow
    4: [0.80, 0.90],   // Z4  threshold    orange
    5: [0.90, 1.00],   // Z5  VO2 max      red (flashes at maxHR)
};
```

The **38–43 %** / **50–60 %** split is intentional: the 43–50 % band belongs to no
zone, and `getHRZone()` returns `null` there (the UI shows `--`). Do not "fix" it
to 38–50 % — that was the older design and it is what the README used to say.

`getHRZone(bpm)` returns 0–5 or null. `getZoneBpmBounds(zone)` returns `{low, high}` BPM for a zone number (**integer-rounded** via `Math.round`).

> **Single source of truth (fixed 2026-07-15):** `getHRZone` now derives its bounds from `getZoneBpmBounds` rather than recomputing them from the raw `ZONE_BOUNDARIES` floats. Previously a BPM near a zone boundary could be labeled one zone (for the on-screen label / pillar color) while being treated as a *different* zone by the speed control math — e.g. with `restHR=70 / maxHR=154`, BPM=120 was labeled Z1 but counted as inside Z2. Both functions now agree on every integer BPM. Overlap at a shared boundary BPM resolves to the higher zone (unchanged behaviour).

---

### HRM (Heart Rate Monitor) feature

**Where it runs:** on Colas's **Android phone, in Chrome for Android** — the `#debug: 1` traces quoted in this file come from there. The Linux host `colas` is a development machine (it ran the app once, for a debug session), so its `bluetoothctl` / `hcitool` state says nothing about the phone's Bluetooth stack. Android-specific causes of a hung GATT setup: the strap bonded in Android's Bluetooth settings (the OS auto-reconnects it, so `gatt.connect()` resolves in ~0.2 s over a link Chrome does not really drive), the COROS app keeping the strap subscribed in the background, and Chrome background tabs frozen by Doze holding a half-dead link. Recovery: *Forget* the strap in Android's Bluetooth settings, force-stop the COROS app, close old Chrome tabs, or toggle the phone's Bluetooth off/on.

Standard BLE Heart Rate Profile (`service 0x180D`, characteristic `0x2A37`, Notify). Implemented as:

- **`connectHRM()`** — BLE device picker filtered by `heart_rate` service, then `openHrmGatt()` (see below)
- **`disconnectHRM()`** — clean disconnect
- **`openHrmGatt()`** — connects, discovers `heart_rate_measurement` and subscribes, retrying up to `HRM_CONNECT_ATTEMPTS = 3` (backoff `HRM_CONNECT_RETRY_MS × attempt` = 1.5 s then 3 s, all attempts inside `HRM_CONNECT_BUDGET_MS`). Three failure modes justify it: BlueZ can resolve `gatt.connect()` before the ATT link is really up (the next operation then throws `GATT Server is disconnected…` on a perfectly good strap); a link left over from a previous session (strap asleep, phone slept) keeps reporting `connected === true` forever while every operation fails — `connect()` short-circuits on it, so it is closed in the `catch` and the retry opens a fresh connection; and a strap held by another central (phone app, watch) can leave a GATT operation **pending forever**, which used to leave the ❤ box spinning with no status at all.
- **Do not disconnect a link pre-emptively before connecting.** v1.1.2-dev.1 did (`if (gatt.connected) disconnect(); 150 ms; connect()`), and it broke a setup that had worked since v1.0.0: on Android the ACL never really goes away, so the reassembled link reports *up* in ~0.2 s while the strap's GATT side is still unwinding the old connection — `startNotifications` then never answers (2026-11-13 log: `HRM link up (attempt 1)` at +7.4 s, `startNotifications timed out after 10s` at +18.6 s). A link Chrome already has is now used as is (traced as `HRM link already up … using it as is`) and only closed after it has actually failed.
- **`hrmOpTimeout(promise, label, ms?)`** — races every GATT operation against `HRM_OP_TIMEOUT_MS = 10000` (or a shorter budget), so a hang becomes `startNotifications timed out after 10s` in the status line. Any failed attempt closes the link (`disconnect()`) and retries after the backoff, so the next attempt starts a real connection. `trace()` records `HRM link up` / `HRM notifications on` per stage, so a log always shows where it stopped, and the failure message distinguishes "not answering" (timeout → wear it to wake it) from "unreachable" (connection error).
- **Same-link CCCD retry** — when only `startNotifications` times out, it is retried once on the **same link** (`HRM_CCCD_RETRY_MS = 5000`, on a freshly obtained characteristic object so Chrome cannot hand back the pending subscription) before the link is torn down: some Android stacks drop the first descriptor write after a connect, and 5 s is cheaper than a reconnect. Traced as `HRM startNotifications timed out — retrying on the same link`.
- **First-beat watchdog** — after a successful connect, `HRM_FIRST_BEAT_MS = 15000` without any notification switches the status to "connected but sending no data — is the strap worn and in contact?". The first notification traces `HRM first BPM n`; the disconnect handler traces `HRM disconnected`.
- **`attachHrmDisconnectHandler(device)`** — attaches `gattserverdisconnected` once per device (requestDevice hands back the same `BluetoothDevice` instance every time, so an unguarded listener accumulates); clears `hrmCharacteristic` and `currentHeartRate`
- **`hrmConnecting`** — guards against double taps on the HR box; `handleHrmBoxClick()` only treats the link as connected when `gatt.connected && hrmCharacteristic`, otherwise a stale server would make the tap "disconnect" nothing
- **`handleHrmNotification(event)`** — parses flags byte (uint8 vs uint16 HR value), stores `currentHeartRate`, calls `updateHrmUI` + `updateHrZone`
- **`updateHrmUI(state, bpm)`** — toggles the HR metric box between connect/connecting/connected states
- **`updateHrZone(bpm)`** — updates zone display, background color, max-HR flash animation, mercury pillars, and calls `applyHrmZoneAdjust()` on zone change
- **`updateHrmPillars(bpm, zone)`** — drives the mercury visualizer

**Zone-change trigger**: `lastHrZone` global tracks the previous zone. When `getHRZone(bpm) !== lastHrZone`, `applyHrmZoneAdjust()` fires immediately (in addition to the 10 s interval).

---

### Zone-targeted speed control (`X/Zn` steps)

When a step has a `targetZone` and HRM is connected:

**`enterStepSpeed(step, isInitialStart)`** — called instead of raw `sendSpeed` at step transitions. If HR is already within the target zone bounds, skips `sendSpeed` entirely (keeps current belt speed as baseline). Otherwise sends the stated fallback speed.

**`startHrmZoneControl(zone)`** — starts the adjustment loop:
1. Calls `applyHrmZoneAdjust()` immediately
2. Sets `setInterval(applyHrmZoneAdjust, HRM_ZONE_INTERVAL_MS)` where `HRM_ZONE_INTERVAL_MS = 10000` (10 s). The hard min spacing between actual adjustments is `HRM_ZONE_MIN_MS = 5000` (5 s); same-direction spacing is governed much longer by the settle lockout (`settleSeconds`, see below).

**`stopHrmZoneControl()`** — clears the interval, nulls `hrmStepTargetZone`, resets `lastAdjust` (a new zone step must not inherit a stale lockout)

**`applyHrmZoneAdjust()`** — runs every 10 s and on zone changes:
- Guards: `!isRoutineActive || isPaused`, `hrmStepTargetZone === null`, `currentHeartRate <= 0`, `lastHrmZoneAdjust` < 5 s ago
- Calls `learnHrGain()` (online gain learning, see below)
- Delegates the speed-delta decision to `calculateSpeedAdjustment(currentHR, zoneLow, zoneHigh)` (see "HR zone controller tuning" below)
- **Settle lockout**: blocks a same-direction adjustment if the previous one is < `settleSeconds` (35 s) old and the HR hasn't moved ≥2 BPM the *wrong* way since (the escape hatch for an insufficient correction). HR lags a speed change by ~30 s, so faster same-direction stacking just winds up overshoot.
- Clamps speed to `[speedMinThreshold, maxSpeedLimit]`
- Sets `lastHrmZoneAdjust = Date.now()`, records `lastAdjust = {time, dir, hr}`, and sets `currentTargetSpeed = newSpeed` before calling `sendSpeed`

Zone control lifecycle: starts at routine-start / step-transition / RESUME (app button and physical remote); stops at PAUSE / STOP / step-end via `clearAllIntervals()` which includes `stopHrmZoneControl()`.

---

### HR zone controller tuning (`HR_CONTROL_CONFIG` + `calculateSpeedAdjustment`)

**Architecture (v0.8.10-dev.2 rewrite):** one projection rule replaces the old PHASE 1/PHASE 2 split. Every 10 s (and on zone changes) the controller projects the HR trend `horizonSeconds` ahead, measures how far past the nearest zone edge the HR will sit (taking the worse of now and projected), and converts that breach to km/h through the **online-learned gain `hrPerKmh`** (BPM per km/h). Clamped to `±maxSpeedChange`, rounded to 0.1 km/h — the rounding doubles as the deadband (sub-~0.7 BPM breaches need no correction). There is no explicit deadband, no fixed nudges, no proportionalGain, no brake (the brake fired 1.6% of the time at real trend rates — dead code).

| Parameter | Value | Why |
|---|---|---|
| `emaAlpha` | 0.2 | EMA smoothing for the HR trend (BPM/s). |
| `horizonSeconds` | 30 | Projection horizon ≈ the measured HR↔speed lag (29 s median in the 2026-07-31 log). May exceed the check interval now — the settle lockout, not the interval, is the damping mechanism. |
| `settleSeconds` | 35 | Anti-stacking lockout: min spacing between *same-direction* adjustments. The root fix for the limit cycle. |
| `maxSpeedChange` | 0.5 | Hard clamp on a single adjustment, km/h. |
| `learnAfterSeconds` | 300 | No gain learning during the first 5 min of a routine (HR warm-up is unrepresentative). |
| `gainAlpha` | 0.25 | EMA weight of each gain sample. |
| `gainMin` / `gainMax` | 2 / 20 | Sanity clamps for the learned gain. |

**`hrPerKmh`** (global, seeded 7.0 BPM per km/h from log analysis; ~7 measured for Colas) — not persisted across sessions.

**`learnHrGain()`** — called from `applyHrmZoneAdjust`. Scans `hrHistory` (1 Hz `{t, speed, hr}` samples pushed in `handleHrmNotification`, pruned to 4 min) for the most recent isolated speed change 40–75 s old (speed held since, |Δspeed| ≥ 0.05, |ΔHR| ≥ 2 BPM). Gain sample = `(ΔHR − trendBefore×age) / Δspeed` (momentum-corrected; `trendBefore` from a 30 s lookback, clamped ±0.3 BPM/s). Non-positive samples rejected as contaminated. EMA'd into `hrPerKmh`, clamped [2, 20]. Each change yields at most one sample (`sampled` flag on the history entry).

**`updateHrTrend(currentHr)`** — EMA over per-tick BPM/s. Calls closer than 5 s apart (zone-change re-fires) return the previous smoothed value — they only inject ±1 BPM quantization noise otherwise.

**`calculateSpeedAdjustment(currentHr, zoneLow, zoneHigh)`** — the single projection rule:
```
projected = hr + trend × horizonSeconds
overshoot  = max(hr, projected) − zoneHigh → delta = −overshoot  / hrPerKmh
undershoot = zoneLow − min(hr, projected)  → delta = +undershoot / hrPerKmh
clamp ±maxSpeedChange, round to 0.1
```

**Limit-cycle failure mode (v0.8.10-dev.1 log, `Z2 1h` step 7, `DEV/colas-2026-07-31.log`):** persistent ~135 s oscillation for the whole 50-min Z2 step — only 55% time in Z2 (Z1 21%, Z3 24%), 26 Z3 excursions, HR 115–136, speed swinging 2.6–5.9 km/h. Root cause: adjustments fired every 10 s (5 s min spacing) against a ~29 s physiological lag, so up to 3 same-direction moves stacked before the first was measurable (observed +1.4 km/h ramps ≈ +10 BPM > zone width 9 BPM); the anti-windup brake (`brakeThreshold` 0.4 BPM/s) never fired because real trends are ~0.16 BPM/s median. A replay harness (real 1 Hz HR trace through both controllers) measured: old 167 adjustments (133 stacked) vs new 79 (35, mostly the intended escape-hatch), speed churn 51.3 → 20.5 km/h.

**Earlier failure mode (v0.7 → v0.8.1 logs, `Z2 40mn` step 4):** HR oscillated between Z1 and Z3 in a 2–4 min cycle while speed swung through a ~1.5 km/h band centered on the Z2 midpoint. Three interacting causes: (1) the 4:1 down-favoured nudge ratio kept recovery from Z1 slow; (2) `emaAlpha=0.3` + lookahead 30 s > the 20 s interval projected ramp momentum past the next check and cut speed preemptively; (3) the maintenance phase had no trend-aware brake. Addressed in v0.8.2; the whole nudge/brake apparatus was then replaced by the projection rule above in v0.8.10-dev.2.

---

### Metrics layout

```
[ Incline  ] [ ❤ HR zone strip | HR BPM  ]   ← topMetrics row
[ Elapsed  ] [      Remain               ]   ← bottomMetrics row
```

Wrapped in `#metricsWrapper` with `container-type: inline-size` (critical — restores `cqw` font scaling relative to grid width, not viewport).

`#topMetrics` auto-collapses via CSS `:has()` when both `#inclineMetric` and `#hrmCell` have class `metric-off`:
```css
#topMetrics:has(#inclineMetric.metric-off):has(#hrmCell.metric-off) { display: none; }
```

**Mercury visualizer**: two `.hrm-pillar` divs (4px wide, defined by `--hrm-pillar-width`) sit as absolutely-positioned children of `#hrmCell` at left/right edges. Each has a faint `.hrm-track` (glass tube) and a `.hrm-fill` that grows from the bottom. Height = `(currentBPM − zoneLow) / (zoneHigh − zoneLow) × 100%`. On zone change: instant reset to 0% via `transition:none` + forced reflow, then animated up in the new zone's color.

---

### Session log

Markdown log of each workout session, stored in `localStorage` under `wpss_session_log`. Entries prepended (newest first). Each entry records: date/time, routine name, start step (if not from beginning), elapsed time, completion status, speed modifier history, **total km** (computed as sum of `speed × duration / 3600` over all segments), and **total steps** (per segment: `distance_m / stepLen`, where `stepLen = metaStepLength × (speed / 3.0)^0.42` and `distance_m = speed × duration / 3.6`; segments with `speed ≤ 0` skip). Accessible via "View Session Log" button in Manager view with Copy and Clear actions.

---

### Remote pause/resume detection

The walkpad's physical remote is detected via BLE speed notifications. The threshold below which the walkpad is considered stopped is `speedMinThreshold` (resolved from BLE `bleMinSpeed` → `#min-speed` file metadata → `DEFAULT_MIN_SPEED = 1.0` km/h). When the pad sends a speed notification below this threshold, the app interprets it as a stop/pause from the remote. This makes the detection absolute rather than adaptive to the routine's slowest step.

Two details learned the hard way (2026-10-30, Fousae):
- **Resume is inclusive** (`>= speedMinThreshold`): a pad resumed from the physical
  remote restores its own minimum speed, which *is* the threshold (1.0 km/h on the
  Fousae), so a strict `>` made every remote resume invisible.
- **Our own commands cancel the pending detection**: `sendSpeed()` / `startTreadmill()`
  set `ignoreSpeedChanges` for 7 s, and used to leave an already-armed pause timer
  running. A low frame from just before a step change then paused the whole routine
  1.5 s later, in the middle of the next step. Both now call
  `cancelRemotePauseDebounce()` when they take over the speed.

---

### Other notable features

- **Step-jump list**: shown when routine is idle/stopped; tapping a step positions the routine there in paused state with all widgets updated. RESUME then starts from that point.
- **Modifier buttons** (`--- -- - = + ++ +++`): apply ±5/10/20% speed multiplier; fires `sendSpeed` immediately when clicked mid-routine.
- **GitHub Gist loading**: "Load Gist from Clipboard" button reads clipboard, extracts gist ID via regex (handles normal/raw/anonymous URLs), fetches via GitHub REST API (CORS-safe), parses as routines file, and sets `?gist=<id>` in URL for bookmarking.
- **Incline support**: FTMS opcode `0x03`, signed 16-bit at 0.1% resolution. `routineHasIncline` tracks whether the routine has any incline at all — a per-step `X%` token *or* the `#incline:` metadata, which now counts exactly like a step token (it used to be a display-only setting that hid the metric).
- **Wake lock**: screen kept on during active workout via `navigator.wakeLock.request('screen')`. Bug fix: also acquired on non-standard start paths (step-jump → resume).

---

### Test suite

`test/RUN-ALL-TESTS` (bash, run from repo root or test/) runs everything:
- `test/check-types.cjs` — extracts the app's inline `<script>` and runs
  `tsc --checkJs` on it with a **baseline of 36 known errors**; fails only
  when the error count rises. TypeScript is a lint gate only — the app
  stays a zero-build single file (no build step, no TS source).
- `test/nav.test.cjs` — Playwright (already a dependency): serves the repo
  over a local HTTP server and drives the real UI through the
  manager↔driver↔connections view matrix, asserting the bookmarkable-URL
  invariants (`?gist=`/`?https=` and the `t=`/`dbg=` flags survive every
  view switch, and reloading the shown URL restores the same state).
- `test/fixtures/routines.txt` — small routines file served to the tests.

When adding a view-switch or URL-handling change, extend `nav.test.cjs`
rather than testing by hand.

---

### Collaboration style notes (important for next agent)

- **Never publish URLs of Colas's private server** (`nahaboo.org` /
  `tm.nahaboo.org`) in README, docs, screenshots or any user-visible text.
  Historical mentions already in this file's session notes are fine, but
  new docs/screenshots must not expose them.

- Colas uploads the current file at session start and often mid-session when he's made local changes. Always `diff` against working copy before adopting.
- He version-bumps locally and reports it; sync the working copy's version string accordingly.
- He prefers tightly scoped diffs — flag pre-existing bugs separately rather than silently fixing them.
- Surface judgment calls explicitly before implementing.
- **Commit workflow (always follow these exact steps, in order):**
  1. Bump the version: increment the patch number and append `-dev.1`, e.g. `v0.8.5` → `v0.8.6-dev.1`. If already `-dev.X`, increment X, e.g. `v0.8.5-dev.3` → `v0.8.5-dev.4`. The version lives in `#version:after {content: "vX.Y.Z"};` in the CSS.
  2. Load the `auto-commit` skill.
  3. Stage all changes with `git add -A`.
  4. Commit using `git -c user.name="<ModelName>" -c user.email="<modelname>@assistant.local" commit -m "<conventional-commit message>"`. Use the real model name (DeepSeekV4Flash, glm52, qwen36, mimo25, gemma4flash, etc.), not the harness name `opencode`.
  5. Use Conventional Commits format in lowercase: `feat:`, `fix:`, `docs:`, `chore:` etc.
  6. Never commit or stage build artifacts, temporary files, or local test binaries.
- **Code discipline:**
  - Never remove comments not pertaining to sections you modify unless asked.
  - Keep functions modular and focused; if a function exceeds 50 lines, consider breaking it down.
  - Do not refactor or rewrite working code outside the scope of the requested change.
- The working copy lives at `/home/claude/walkpadspeed.html`; always copy to `/mnt/user-data/outputs/walkpadspeed.html` and call `present_files` to deliver.
- Always run `node --check` on the extracted script before delivering.

---

### Session 2026-07-14: Unused variable cleanup

- Removed **7 unused variables/constants**: `lastHrmZoneBpm`, `metaAge`, `HRM_ZONE_DAMPEN_UP`, `HRM_ZONE_DAMPEN_DN`, `HRM_ZONE_LOOKAHEAD`, `HRM_ZONE_LA_DAMPEN_UP`, `HRM_ZONE_LA_DAMPEN_DN`
- Fixed implicit global (`content` without `const`) in `loadHttpsRoutines()` — was leaking to window scope
- Committed as `4973f59` under `DeepSeekV4Flash`

---

### Session 2026-07-15: HR zone control tuning (v0.8.2)

Two commits, both authored `glm52` on `main`:

**`871ddcb` — Tune HR zone control: damp Z2 oscillation.** Driven by `DEV/logs-v0.8.1.txt` analysis of a 40-min `Z2 40mn` session and two `Short Digestive` (Z0) sessions, all with the same user (`restHR=70`, `maxHR=154`, born 1960). Findings:

- **Z0 ("Short Digestive") control worked well** in both logged sessions — the strong `nudgeDown=-0.4` matched its "don't escape upward" intent, and the controller held HR inside 102–112 BPM with only minor excursions.
- **Z2 ("Z2 40mn", step 4) oscillated badly.** HR cycled between Z1 and Z3 in a 2–4-min loop; speed swung through a ~1.5 km/h band centered on the Z2 midpoint. Three interacting causes identified (see "Oscillation failure mode" above).
- Changes made: `emaAlpha` 0.3 → 0.2, `lookaheadSeconds` 30 → 20 (now matches `HRM_ZONE_INTERVAL_MS`), `brakeThreshold` 0.3 → 0.4, `nudgeDown` -0.4 → -0.2, `nudgeUp` +0.1 → +0.2 (now symmetric). PHASE 2 now boosts the nudge ×1.5 when HR is in the outer half AND still moving fast toward the edge — ports the D-controller brake from PHASE 1. Deadband widened from `zoneRange/6` to `zoneRange/4` (central 50%).
- Inline HTML comments and README "every 30s" wording were stale; updated to 20 s interval + 20 s lookahead.

**`0d7c080` — Fix `getHRZone` / `getZoneBpmBounds` rounding mismatch.** `getHRZone` classified a BPM against the raw float zone boundaries, while `getZoneBpmBounds` uses `Math.round()` to produce integer BPM limits. With `restHR=70 / maxHR=154`, BPM=120 was labeled **Z1** by `getHRZone` (label + pillar color) but treated as **inside Z2** by the speed control math. Fix: `getHRZone` now iterates `getZoneBpmBounds(0..5)` as its single source of truth, so labels and speed control agree on every integer BPM. Boundary overlap still resolves to the higher zone. No change to the `bpm >= maxHR → Z5` short-circuit.

**Final doc commit** — `AGENTS.md` restructured the zone-control section around `HR_CONTROL_CONFIG` + the v0.8.2 tuning table; the README "speed/Zone" line and zone bullet list were refreshed to the current 20 s interval and 38–50 / 50–60 / 60–70 / 70–80 / 80–90 / 90–100 % boundaries (the README zone list had drifted to Z1=50–55%, Z2=65–70%). `metaHRM` was missing from the metadata-globals list; added.

---

### Session 2026-07-18: Pad max-speed cap via FTMS 0x2AD1

Reads the walkpad's advertised speed range over BLE and uses the maximum as a hard cap on every speed sent to the pad. Previously the app could request speeds above the pad's real maximum (e.g. sending 8 km/h to a 6 km/h walking pad), causing the pad to ignore the command or clamp silently with no feedback.

**BLE read (FTMS Supported Speed Range, `0x2AD1`):** added `FTMS_SUPPORTED_SPEED_RANGE_UUID` and a read in `connectTreadmill()` right after the data channel subscription. The characteristic is 6 bytes = 3 × sint16 LE at 0.01 km/h resolution, parsed into:
- `bleMinSpeed` — stored for future use, not yet applied
- `bleMaxSpeed` — drives the effective cap (preferred source)
- `bleMinIncrement` — stored for future use, not yet applied

The read is wrapped in try/catch; many walking pads don't expose `0x2AD1`, in which case the app falls back to the file override or default without failing the connection.

**New `#max-speed` metadata:** optional routines-file override (km/h) for when the pad's BLE max is unreadable. Parsed in `parseMetadata` into `metaMaxSpeed`. Defaults to `null` (absent).

**Resolution order (`updateMaxSpeedLimit()`):** `bleMaxSpeed` (BLE) → `metaMaxSpeed` (file) → `DEFAULT_MAX_SPEED = 12`. Called from `parseMetadata` (manager + driver init) and after the BLE read on connect, so the cap is correct in both views and updates live once the pad connects.

**Where the cap is applied:**
- `sendSpeed()` — clamps the effective (post-`speedMod`) speed before building the FTMS frame
- `applyHrmZoneAdjust()` — clamps the HR-zone-controller new speed against `maxSpeedLimit` instead of the fixed `HRM_SPEED_MAX = 20.0`

No change yet to `bleMinSpeed` / `bleMinIncrement` consumers — they are reserved for a future version that may snap speeds to the pad's increment grid or refuse sub-minimum speeds.

---

### Session 2026-07-18: Total km in session log

**Commit `487f4b5`** by `DeepSeekV4Flash` — `buildSessionLogEntry()` now appends total distance walked to the comment line of each session entry. Computed as `sum(seg.speed × seg.duration / 3600)` over all finalized segments (speed in km/h, duration in seconds). Displays to 3 decimal places (e.g. `, 2.475 km`). Zero-segment sessions still return `null` and are not logged.

Also bumped version from `v0.8.4` → `v0.8.5-dev.1` for the commit.

---

### Session 2026-07-20: Pad min-speed floor (`#min-speed` metadata)

**No commit yet.** Implemented `#min-speed` metadata and `speedMinThreshold` variable to set a pad minimum speed, replacing the adaptive `stopDetectThreshold()` with an absolute threshold.

**Resolution order (`updateSpeedMinThreshold()`):** BLE `bleMinSpeed` (0x2AD1) → `#min-speed` metadata → `DEFAULT_MIN_SPEED = 1.0` km/h. Called from `parseMetadata` and after BLE read on connect.

**Changes:**
- New globals: `DEFAULT_MIN_SPEED = 1.0`, `metaMinSpeed = null`, `speedMinThreshold = DEFAULT_MIN_SPEED`. Removed unused `speedThreshold` variable.
- `updateSpeedMinThreshold()` — resolves the effective floor, parallel to `updateMaxSpeedLimit()`.
- Routine step speed clamping: parsed speed floored to `speedMinThreshold` in `buildRoutineSteps()`.
- HR zone adjust: `applyHrmZoneAdjust()` clamps to `speedMinThreshold` instead of the old fixed `HRM_SPEED_MIN = 0.5`. Removed `HRM_SPEED_MIN` / `HRM_SPEED_MAX` constants.
- Remote pause detection: all 5 `stopDetectThreshold()` call sites replaced with `speedMinThreshold`; function deleted.
- Test mode: `simulateRemoteStartPause()` uses `speedMinThreshold * 0.8`.
- AGENTS.md: fixed stale references to `stopDetectThreshold` / `speedThreshold` in the Remote pause/resume detection section.

Bumped version string from `v0.8.6-dev.3` → `v0.8.7-dev.1`.

---

### Session 2026-07-20: Adaptive step length (`speed>Zone` syntax)

**No commit yet.** Added a new step syntax for zone-terminated steps: `speed>Zone` (e.g. `4.0>Z2 20m Aerobic`). When the step is active and HRM is connected, the step ends as soon as the target HR zone is reached, regardless of remaining duration. If the HR zone is not reached before the max duration expires, the step ends normally.

**File format:**
- `4.5/Z2 20m Aerobic` — zone-targeted speed control (existing; adjusts speed to stay in Z2)
- `4.0>Z2 20m Aerobic` — zone-terminated step (new; runs at 4.0 until Z2 is reached or 20m elapses)

**Packed format (URL roundtrip):** `4.5>Z2-1200-Aerobic` (`>` before `Z` differentiates from zone-targeted `4.5Z2-1200-Aerobic`).

**Changes:**
- `buildRoutineSteps()` — updated regex to `/^(\d+(?:\.\d+)?)(>?Z([0-5]))?$/i`, added `zoneTerminate` boolean to step object
- Manager text parser — handles `/` (zone-targeted) and `>` (zone-terminated) separators in speed token, encodes `>` in packed format
- Step-jump list — shows `>Z{zone}` for zone-terminated steps
- `startClockLoop()` — adds zone-terminated check at each tick: when `hrmCharacteristic` is connected, `currentHeartRate > 0`, and the current HR zone meets or exceeds the target, forces `secondsLeftInStep = -1` to end the step. Records `step.actualDuration = step.duration - secondsLeftInStep` on early termination.
- `startHrmZoneControl()` call sites (4 locations) — guarded with `!step.zoneTerminate` so zone-targeted speed control is not activated for zone-terminated steps
- `enterStepSpeed()` — skips the "already in zone" optimization for zone-terminated steps (always sends the stated speed)
- Session log segments already track actual elapsed time per segment, so early-termination durations are correctly reflected in logging (`totalKm`, `totalSteps`, elapsed time) without additional changes.

**Edge cases handled:** without HRM connected, zone-terminated steps run to max duration (graceful fallback); test mode (simulated HRM) works identically; steps already in the target zone at start end after 1 tick (immediate transition to next step).

---

### Session 2026-07-31: HR zone controller rewrite (v0.8.10-dev.2)

Driven by `DEV/colas-2026-07-31.log` analysis (50-min `Z2 1h` step 7: only 55% time in Z2, HR 115–136 in a ~135 s limit cycle, speed swinging 2.6–5.9 km/h — see "Limit-cycle failure mode" in the tuning section above for the numbers). The two-phase nudge/proportional/brake controller was replaced by a single projection rule with an online-learned gain. User's brief: add "memory" of how HR responded to past speed changes (ignoring the first 5 min warm-up), and anticipate zone exits further ahead than 10 s.

**Changes (all in the HRM zone control block of `walkpadspeed.html`):**
- `calculateSpeedAdjustment()` rewritten (~60 → ~15 lines): projects `hr + trend × horizonSeconds` (30 s ≈ the measured 29 s lag), takes the worse of now/projected past the nearest zone edge, converts the breach to km/h via `hrPerKmh`. Deadband, PHASE 1/2, `proportionalGain`, `brakeThreshold`, `nudgeUp/Down`, `lookaheadSeconds` all deleted — the 0.1 km/h rounding is the deadband.
- Settle lockout in `applyHrmZoneAdjust()`: same-direction adjustments blocked for `settleSeconds` (35 s) unless HR moved ≥2 BPM the wrong way (escape hatch). The anti-stacking root fix. `lastAdjust` state; reset in `stopHrmZoneControl()`.
- `learnHrGain()` (new): learns `hrPerKmh` (seed 7.0, clamp [2,20], EMA α 0.25) from isolated speed changes 40–75 s old in the new 1 Hz `hrHistory` buffer (4 min, fed by `handleHrmNotification`); momentum-corrected samples; gated on `totalElapsedSeconds > 300` (the warm-up exclusion). Not persisted across sessions.
- `updateHrTrend()`: min-dt guard — calls <5 s apart (zone-change re-fires) no longer inject quantization noise into the trend EMA.
- `HRM_ZONE_INTERVAL_MS` / `HRM_ZONE_MIN_MS` stay at the user's local 10 s / 5 s.

**Verification:** `node --check` OK. A throwaway replay harness fed the log's real 1 Hz HR trace through both controllers (identical input): old = 167 adjustments (133 stacked <35 s), Σ|Δspeed| 51.3 km/h; new = 79 (35, mostly escape-hatch), 20.5 km/h. A closed-loop synthetic plant (two-timescale HR response + drift) confirms both controllers are stable on a well-behaved plant (~99% in zone), so the new one doesn't destabilize anything — the replay shows it breaks the limit cycle on real dynamics. First real-session validation pending; watch `hrPerKmh` convergence (status-line adjustment sizes will reflect it).

Version bumped `v0.8.10-dev.1` → `v0.8.10-dev.2`.

---

### Session 2026-08-04: HR zone controller rewrite, CSS cleanups, prevStep/nextStep

**Commits:** `503d553` through `763ea13` (author KimiK3), culminating in Colas's release as v0.9.0.

#### HR zone controller rewrite (v0.8.10-dev.2, commit `503d553`)

Driven by `DEV/colas-2026-07-31.log` analysis (50-min `Z2 1h` step 7: only 55% time in Z2, HR 115–136 in a ~135 s limit cycle, speed swinging 2.6–5.9 km/h). The two-phase nudge/proportional/brake controller was replaced by a single projection rule with an online-learned gain. User's brief: add "memory" of how HR responded to past speed changes (ignoring the first 5 min warm-up), and anticipate zone exits further ahead than 10 s.

**Changes (all in the HRM zone control block of `walkpadspeed.html`):**
- `calculateSpeedAdjustment()` rewritten (~60 → ~15 lines): projects `hr + trend × horizonSeconds` (30 s ≈ the measured 29 s lag), takes the worse of now/projected past the nearest zone edge, converts the breach to km/h via `hrPerKmh`. Deadband, PHASE 1/2, `proportionalGain`, `brakeThreshold`, `nudgeUp/Down`, `lookaheadSeconds` all deleted — the 0.1 km/h rounding is the deadband.
- Settle lockout in `applyHrmZoneAdjust()`: same-direction adjustments blocked for `settleSeconds` (35 s) unless HR moved ≥2 BPM the wrong way (escape hatch). The anti-stacking root fix. `lastAdjust` state; reset in `stopHrmZoneControl()`.
- `learnHrGain()` (new): learns `hrPerKmh` (seed 7.0, clamp [2,20], EMA α 0.25) from isolated speed changes 40–75 s old in the new 1 Hz `hrHistory` buffer (4 min, fed by `handleHrmNotification`); momentum-corrected samples; gated on `totalElapsedSeconds > 300` (the warm-up exclusion). Not persisted across sessions.
- `updateHrTrend()`: min-dt guard — calls <5 s apart (zone-change re-fires) no longer inject quantization noise into the trend EMA.
- `HRM_ZONE_INTERVAL_MS` / `HRM_ZONE_MIN_MS` stay at the user's local 10 s / 5 s.

**Verification:** `node --check` OK. A throwaway replay harness fed the log's real 1 Hz HR trace through both controllers (identical input): old = 167 adjustments (133 stacked <35 s), Σ|Δspeed| 51.3 km/h; new = 79 (35, mostly escape-hatch), 20.5 km/h. A closed-loop synthetic plant (two-timescale HR response + drift) confirms both controllers are stable on a well-behaved plant (~99% in zone), so the new one doesn't destabilize anything — the replay shows it breaks the limit cycle on real dynamics. First real-session validation pending; watch `hrPerKmh` convergence (status-line adjustment sizes will reflect it).

#### Incline metric regression fix (v0.9.0-dev.2, commit `0e7492a`)

When `#incline: N` was set in the routines file's metadata (which suppresses the fixed-incline metric from the UI per design), the `!metaIncline` guard in the connect path also blocked the metric from appearing when per-step inline `X%` incline overrides existed in the packed URL. The fix removes `!metaIncline` from the two `classList.remove('metric-off')` calls (test-mode connect and BLE connect paths) so `routineHasIncline` alone controls visibility. The `#incline:` metadata still suppressed the metric when all steps used the implicit default (changed in v1.0.3-dev.17: metadata now shows and drives the incline like a step token).

Root cause traced to commit `739c672` which added the `!metaIncline` guard alongside metadata support.

#### Stoppause button CSS (v0.9.0-dev.3–dev.5, commits `d7ceb7e`, `15d34d0`, `a1cf622`)

Series of CSS tweaks on the `#stoppause` row (`⏮ ⏭ STOP PAUSE`):

- `#stoppause` set to `display: flex; align-items: stretch; gap: 5px` so all four buttons match height.
- `.change-step` now has the same padding (`1.5rem 1rem → 0.75rem 1rem`) as the other buttons; the `⏮⏭` pair groups tight on the left while `STOP PAUSE` pushes to the right via `#stoppause button:nth-of-type(2) { margin-right: auto; }`.
- `.stop-btn` / `.pause-btn` / `.resume-btn` / `.plause-btn` get `font-size: 2.4rem` and `padding: 0 1rem` — the stretched flex container handles height so no vertical padding is needed.

#### prevStep / nextStep (v0.9.0-dev.6, commits `818dcab`, `763ea13`)

New `async` functions placed after `jumpToStep`:

- `prevStep()` — restarts the current step from its beginning (single tap) or goes to the start of the previous step (double-tap within 1 s). At step 0, double-tap beeps and ignores. Maintains the routine's running state.
- `nextStep()` — skips to the start of the next step, counting the current step as fully elapsed. If on the last step, calls `stopTreadmill(true)` to end the routine.

Both recompute `totalElapsedSeconds` from step durations, send the correct speed/incline via `enterStepSpeed`, reset zone control, and update all UI displays (timers, progress bars). A `lastPrevStepTime` global tracks the double-tap window.

#### Deferred bug analysis (dev/bug1.md)

After implementation, the user reported NaN time displays and a global progress bar stuck at 0% when starting from a non-first step or using `nextStep`. Three root causes were identified and documented in `dev/bug1.md` for a future agent to fix:

1. `routineTotalDuration` may be `0` when `updateGlobalProgress` fires (clobbered by `resetRoutineState`).
2. `currentTargetSpeed` not set before `enterStepSpeed` in `prevStep`/`nextStep` — zone-control skips cause stale speed.
3. Division by zero in `startClockLoop` when `totalStepDuration = 0`.

Version bumped through `v0.8.10-dev.2` → `v0.9.0-dev.6` across the session.

---

### Session 2026-10-29: Merach W60 support — FTMS control point, pause/stop, review pass

Field work on a **Merach UltraWalk W60** (BLE name `MR-W60.2-0093`, random address; its
classic audio endpoint advertises separately as `W60.2-0093_Audio`). Two problems were
blocking it, and both were in our code / the environment rather than the pad.

**Environment.** Chrome on Linux does not expose `navigator.bluetooth` by default
(`typeof navigator.bluetooth === 'undefined'`, even in a secure context); it needs
`--enable-features=WebBluetooth`. Colas's Xubuntu launches Chrome through the
`Ctrl+Alt+O` keybinding (`google-chrome`, spawned by `xfsettingsd`) and via
`~/.local/share/applications/google-chrome.desktop`; both now carry the flag. Also,
a pad connected to another central (the MERACH phone app) does not advertise, so it is
invisible to every scanner. Verified on Chrome 156; phone Chrome needs no flag.

**Root cause of the refused speed.** The app never sent FTMS *Request Control*
(`0x00`) and never subscribed to the control point's indications, so a spec-compliant
pad rejected `Set Target Speed` (two beeps, speed snapped back to its own 1.0 km/h)
and the app reported success anyway. New control-point layer (before `startTreadmill()`):
`sendControlCommand()` serialises every write on a promise chain, requests control once
per connection, waits for the `[0x80, opcode, result]` indication (1.2 s) and retries
once after re-acquiring control on `0x05`. Pads that never indicate are detected by the
connect-time probe (`FTMS_CP_PROBE_TIMEOUT_MS`) and keep fire-and-forget behaviour.
Refusals now surface as `Pad refused 3.0 km/h (Operation failed)`.

**Pause/Stop.** `0x02` with speed 0 is below every pad's minimum (invalid parameter);
pause/stop now use `0x08` with its mandatory parameter (`0x02` pause / `0x01` stop),
falling back to the speed-0 trick only when the pad ignores it or does not answer.

**What the W60 reports** (`0x2ACC`/`0x2AD4`/`0x2AD5`): speed 1.00–6.00 km/h (0.10 step),
incline 0–12 % (1 % step), target-setting features = speed + incline. It exposes
`0x2AD4` only — reading the deprecated `0x2AD1` failed silently and left the cap at
12 km/h — plus a vendor channel `0xFFF0` (`0xFFF1` notify, `0xFFF2` write) and an
undocumented `d18d2c10-…` write characteristic. Incline works over plain FTMS `0x03`
(9 % verified): the "encrypted Merach handshake" in TODO.md is wrong.

**Incline sequencing rules (learned the hard way).** The pad ignores a target incline
while it is idle, drops back to 0 % when it stops, and suspends the belt while the deck
travels (0→9 % ≈ 15–20 s). Initial start is therefore: `Start → Set Incline → wait for
the reported incline to settle → Set Speed`, with the deck progress in the status line.
`currentLiveIncline` is parsed from `0x2ACD` flag bit 3 and `scheduleBeltStartCheck()`
reports a belt that never engaged.

**Also fixed in the review pass:** `metaHRM` reset to `null` on every parse (hid the HR
metric unless `#hrm:` was present), implicit `metaAge` global, `buildRoutineSteps()`
throwing on a packed step without a duration, the clock running over a refused start,
`stopTreadmill()` doing nothing without a link, missing `gattserverdisconnected`
handler, `?https=` never read back, HTML escaping of file content in the manager
status, incline clamped to `0x2AD5`, and `Treadmill Data` flag bit 0 misread as "speed
absent" (it is *More Data*; instantaneous speed is mandatory).

**Behaviour changes worth remembering:** session-log segments only split on a ≥ 2 BPM
HR move (jitter used to fragment them), and Eruda is pinned to 3.4.3 with SRI.

**In-app trace.** `trace()` records timestamped control-point writes, their result
codes, machine-status events, step changes and speed/incline changes, and feeds the
collapsible "Debug log" panel in the player view (Copy/Clear). It is completely inert
unless the routines file declares `#debug: 1` or the player URL carries `?dbg=1`;
while enabled, the buffer is mirrored to `localStorage` (`wpss_debug_log`, 800 lines)
so a reload does not lose a capture. This is what resolved the W60 speed/incline
problems — reach for it before guessing.

---

### Session 2026-10-30: Fousae ZX-390 speed divided by ten (v1.1.1-dev.1)

> **Correction (2026-10-30, same day).** The root cause below is *wrong*. The next run's
> trace shows the Fousae reporting a perfectly good `0x2AD4`: `speed 1–6 km/h (inc 0.1)
> [64 00 58 02 0a 00]`, so the cap was 6 all along and 3.0 km/h really was sent. The
> "0.3" was the **continuation frame** being displayed as a live speed — see "Follow-up
> (v1.1.1-dev.2)" below. The plausibility guard added here stays (it protects against
> pads that do report nonsense, and it made the cap visible when it does apply), but it
> fixed nothing on this pad. Lesson: a wrong *reading* and a wrong *command* look the
> same from the outside; get the trace before concluding.

**Report.** After the W60 work, the old Fousae ZX-390 (last good: v1.0.2, commit
`72880ed`) appeared to transmit every speed divided by ten — a `3.0` step displayed and
ran at `0.3`. The routine itself was parsed correctly; nothing in the speed path divides.

**Root cause: the speed cap, not the speed.** *(superseded — see the correction above)*
v1.0.2 read only `0x2AD1` (the deprecated Supported Speed Range) for the cap. The W60
work flipped the probe order to `0x2AD4` first and stopped at the first characteristic
that *exists*, so any pad whose `0x2AD4` reads garbage would cap every speed at it.

**Fix (`readPadSpeedRange()`, new helper next to `updateMaxSpeedLimit()`):**
- both characteristics are probed, not only the first that resolves, so a pad whose
  `0x2AD4` is a stub can be rescued by a sane `0x2AD1`;
- a reading is only accepted when its maximum is plausible
  (`SPEED_RANGE_PLAUSIBLE_MIN = 1.5`, `SPEED_RANGE_PLAUSIBLE_MAX = 30` km/h); anything
  else is traced with its raw hex and skipped, leaving `bleMaxSpeed` null so
  `#max-speed` / `DEFAULT_MAX_SPEED` apply as if the pad exposed nothing;
- short (< 6 byte) values are ignored the same way.
- `sendSpeed()` now says when it had to cap: `Speed 5.5 km/h limited to 3.0 km/h (pad
  maximum)` instead of the misleading `Speed set to 5.5 km/h`. A silent cap is what
  made this bug look like a unit conversion.
- The trace line now carries both the chosen source and the raw bytes:
  `RANGE 0x2AD4: 0.1–0.3 km/h (inc 0.1) [0a 00 1e 00 0a 00] — implausible, ignored`
  then `RANGE using pad range → cap 6 km/h, floor 1 km/h`.

**Verified** with a Playwright FTMS mock (control point, data, status, range) over six
pad shapes: a stub `0x2AD4` (0.3) next to a sane `0x2AD1` (1–6) → 3.0 sent; W60
(`0x2AD4` only, 1–6) → 3.0; tenths-of-km/h `0x2AD4` alone with and without `#max-speed`
→ 3.0 (fallback); a genuine 3.0 km/h pad → 3.0 for a 3.0 step and a *visible* limit for
the 5.5 step; no range characteristic at all → 3.0. `node --check` on the extracted
script. None of these shapes is the Fousae — its real range is valid, see below.

#### Follow-up (v1.1.1-dev.2): the Fousae's two frames per second

With the cap fixed, the Fousae still showed **0.1 km/h in the live speed metric,
creeping up by 0.1** every ~25 s, and **step 2 froze the routine at 00:59**. Both
come from the same thing: the pad sends **two Treadmill Data (0x2ACD) frames per
second**. One carries the real speed; the other has flags bit 0 ("More Data") set and
**no speed field at all** — its first two payload bytes are a cumulative total
(distance/energy) that reads as 0.10, 0.20, … km/h. Because it arrives last, it owned
the `#liveSpeed` display; worse, `checkRemoteStateChange()` saw 0.3 km/h <
`speedMinThreshold` on every one of those frames.

Why the timer froze rather than just flickering: the pause detector debounces 1.5 s,
and the alternating good/bad frames kept cancelling it — until a step change called
`sendSpeed()`, which sets `ignoreSpeedChanges` for 7 s. During that window the good
frames were no longer *cancelling* the timer, so a timer armed from the last bad frame
fired, `handleRemoteStateChange()` saw the stale `currentLiveSpeed = 0.3` and paused the
routine. With the belt still running at the new speed, the app sat paused forever.

The fix is to honour bit 0 the way the pad means it, **adaptively**: a frame with the
More Data bit is treated as a continuation (no speed, no pause check) *only once the
same pad has been seen sending a frame without it*. Pads that never clear the bit
(Merach W60, which carries a valid speed in every frame) keep working unchanged — this
is also why v1.0.2's unconditional `if ((flags & 0x0001) === 0)` worked on the Fousae
and showed no live speed on the W60. `handleTreadmillData()` traces the first ignored
continuation frame with its raw bytes, and every DATA trace line now carries the flags.

Also fixed on the way: resume detection was strict (`currentSpeed > speedMinThreshold`)
while a pad resumed by its remote reports exactly its minimum speed (1.0 km/h), so a
remote resume never registered; and a pending pause timer is now cancelled whenever the
app takes over the speed.

Verified with the Playwright FTMS mock over three data shapes (Fousae pairs, W60
all-bit-0, plain 0x0000): the live metric shows 0.0 → 3.0 → 3.5 only, steps 1→2→3 run
through without a pause, and a simulated physical stop/resume pauses, freezes the
clock, resumes and re-sends the step speed.

---

### Session 2026-11-13: HRM connection hardening, and a phone-side hang that was not a regression

Triggered by "I cannot connect to the armband any more" on the phone (Chrome for
Android). The connect path gained, in order: `openHrmGatt()` with up to 3 attempts,
per-operation timeouts (`hrmOpTimeout`, 10 s), a same-link retry of the CCCD write
(5 s, on a freshly obtained characteristic), stage traces, a "connected but silent"
watchdog, and a clear split between "not answering" (timeout) and "unreachable"
(connection error) in the status line.

**One genuine regression was introduced and reverted on the way.** v1.1.2-dev.1 added
`if (gatt.connected) disconnect(); await 150 ms;` before connecting. On Android the ACL
survives the disconnect, so the reassembled link reports *up* in ~0.2 s while the
strap is still unwinding the old connection, and `startNotifications` then never
answers. Since v1.0.0 the app had always used the link it was given. A link Chrome
already has is now used as is (traced as `HRM link already up … using it as is`) and
only closed after an attempt has actually failed, with a 1.5 s / 3 s backoff.

**The remaining failures were environment, not code.** Evidence gathered during the
session: the strap (`D1:F9:A6:A2:FC:6D`, `COROS HEART RATE 7BD111`) advertises with the
Heart Rate service UUID, `Appearance: 0x0341`, connectable+scannable, battery 100 %;
from the `colas` Linux host `StartNotify` answers in **35 ms** and notifications
arrive at 1 Hz (`[00 48]` = 72 bpm), while the same operation hung for 10 s + 5 s on
every one of three Android links. The phone could see the strap in Settings, pair it,
and still fail; after a reboot nothing changed. Then **v1.0.2 (no timeouts, same GATT
calls) connected successfully, and the current build connected right afterwards** —
so it was a transient browser/stack state, not the version.

**The wedge lives in the page, not in the phone.** Opening the app in a **new tab** was
enough to recover — no nRF Connect, no Bluetooth reset, and the reboot had *not* helped.
Mechanism: Android's GATT client allows one outstanding operation per device, so a
`writeDescriptor` that never completes makes Chrome queue every later operation behind
it, and `hrmOpTimeout` only abandons the **JavaScript** wait — it cannot cancel
Chrome's pending operation. That is why retrying inside the same tab is guaranteed to
fail, and why the status line now says **RELOAD the page** when a timeout is the final
error.

Recovery recipe, in order: **reload the app, or open it in a new tab** (first, and
usually sufficient); then toggle the phone's Bluetooth; then clear the **Bluetooth
system app's** storage (drops stale LE bonds and the GATT cache; Web Bluetooth needs
no pairing). `nRF Connect` and `hrmdiag.html` (repo root, deploy it next to
`walkpadspeed.html`) both decide strap-vs-phone without the app: `hrmdiag.html` logs
requestDevice, connect, service, characteristic, a CCCD read, `readValue` and
`startNotifications` separately, each with a timeout, and shares no code with the app.

---

### Session 2026-11-14: Full-code review fixes (v1.1.4-dev.1)

Whole-file review of `walkpadspeed.html` (security excluded per Colas: protected
LANs). dev/bug1.md's three bugs confirmed already fixed. Ten findings fixed, all
verified in a Playwright test-mode run:

- **Clock re-entrancy** (`startClockLoop`): the 1 s async tick awaits
  `enterStepSpeed()` (which can take seconds on incline waits); ticks during that
  window decremented the new step and could double-skip. New `stepTransitioning`
  flag makes ticks skip while a transition is in flight (also set in
  `prevStep`/`nextStep`).
- **`#hrm: 0` on the real path**: the `metric-off` guard existed only in the
  test-mode connect branch; now applied once in `initDriverMode`, covering both.
- **Pad disconnect mid-routine**: `gattserverdisconnected` now pauses the routine
  (clock frozen, intervals cleared, RESUME shown) instead of letting the clock
  log fake distance at the last commanded speed. Extracted as
  `attachPadDisconnectHandler()`, attached once per device (same
  `*DisconnectHooked` pattern as the HRM handler).
- **⏮/⏭ while paused** no longer send speed; RESUME re-sends `currentTargetSpeed`
  as before.
- **"Delete all routines"** now removes `wpss_cached_routines` (it only cleared
  the DOM; routines returned on reload).
- **`ignoreSpeedChanges` timer race**: each release timer is now tracked
  (`scheduleIgnoreSpeedRelease()`); an earlier command's timer can no longer
  clear the flag while a later command is in flight.
- **HR trend EMA state** (`lastHr`/`lastSmoothedTrend`/`lastTimestamp`) reset by
  `resetHrTrend()` on routine reset, HRM disconnect and zone-control start — a
  stale trend used to skew the first projection of a new session.
- **Test-mode pause/stop was broken** since the control-point handshake (latent
  since v1.0.x): the mock `writeValue` did `new DataView(buffer)` on a
  `Uint8Array`. Accepts any `BufferSource` now. Found by the browser test, not
  by the review.
- Dead `step.actualDuration` removed; `sendSpeed` status shows the effective
  (modifier-applied) speed; manager page title typo `walkpadspeeds` fixed.
- AGENTS.md: `metaStepLength` default corrected 0.7 → 0.62; `metaAge` documented
  (it exists and feeds the `220 − age` max-HR default, despite the 2026-07-14
  "removed" note).

---

### Session 2026-11-14 (2): OS-held HRM link detection (v1.1.4-dev.2)

Colas's log (`build=v1.1.4-dev.1`): `HRM link up (attempt 1)` **0.2 s** after
`CONNECT`, then `startNotifications` timed out on all 3 attempts (10 s + 5 s
same-link retry each). A fresh LE connection takes seconds (scan + connect); a
connect resolving in a few hundred ms means the ACL is held by the OS — the band
is bonded in the phone's Bluetooth settings (the OS auto-connects it) or taken by
another app — so Chrome sees a link it cannot drive and every GATT op hangs.
This is the same 0.2 s signature the 2026-11-13 session blamed on the
disconnect-before-connect regression, but here it happens with the reverted
(v1.0.0-style) code, so the OS-held bond is the remaining explanation.

**Changes (`openHrmGatt` / `connectHRM`):**
- `HRM_PHANTOM_CONNECT_MS = 1500` — if `gatt.connect()` resolves in under that
  and the link was not already Chrome's (`wasConnected`), the link is flagged
  `hrmPhantomLink` and traced as `OS-held link, Chrome cannot drive it`.
- On a phantom-link failure the retry loop first waits up to
  `HRM_PHANTOM_RELEASE_MS` (3 s) for the ACL to actually drop after
  `disconnect()`, tracing whether it released or stayed up, then retries.

**Correction (same day).** Colas: the COROS app is not installed and the band is
not in Android's saved devices — so the OS-bond theory is wrong. The 0.2 s
connect still means the link pre-existed the page, but the holder is more likely
another Chrome tab with a half-dead link, or the band's own stale session. The
hint was rewritten accordingly (close other tabs, toggle phone Bluetooth
off/on, wet/wear the band) and the loop no longer breaks early — it waits for
the ACL to drop and retries. Real-phone validation still pending; next step if
it persists is `hrmdiag.html` in a fresh tab.

`node --check` OK. Real-phone validation pending: the hint must actually get
Colas to un-bond the COROS strap in Android settings.

**Final diagnosis (v1.1.4-dev.4, same day).** Colas: no COROS app, band not in
Android's saved devices — OS-bond theory dead. `hrmdiag.html` on the phone then
pinned it: `gatt.connect` OK in 0.3 s, `getPrimaryService`/`getCharacteristic`/
`getDescriptors` all instant (answered from Android's **GATT cache**), then the
first real ATT round-trip (`CCCD readValue`) **hangs 5 s**, `readValue` fails
`unknown reason`, and `startNotifications` returns `NetworkError: GATT operation
already in progress` — Chrome's per-device queue wedged behind the hung read.
Meanwhile the **same band connects and streams fine from the `colas` Linux host's
BLE dongle**, so the band is healthy: the stale link is in the *phone's* stack
(a stale system ACL Chrome adopts but cannot drive). Fixes in `openHrmGatt` /
`connectHRM`:
- phantom attempt with a link that will not drop → `HRM_PHANTOM_COOLDOWN_MS`
  (12 s) cooldown with the link closed, so the phone's stale link can expire;
- on final failure of a phantom link, `hrmDevice.forget()` (promise-traced, not
  awaited) drops Chrome's device record + GATT cache — the next tap re-picks the
  band with a genuinely new link;
- `hrmdiag.html` calls `forget()` on failure too, with a "Connect again and
  re-pick" log line;
- hints/README rewritten (band is fine; tap again and re-pick; toggle phone BT
  if that fails).
Validation pending on the phone.

**Band verified healthy from Linux (2026-11-14, same day).** With the phone
still failing, `bluetoothctl` on colas: band advertising, `connect` instant,
full discovery, `read 0x2A37` → `00 46` (70 BPM), `notify on` → 1 Hz stream,
`Connected: no` afterwards. It accepted the Linux connection while the phone
believed it had a link → the phone's link is a phantom record in the phone's
stack/Chrome, the band serves nobody else. Next diagnostics for the phone:
(1) confirm the deployed build is actually v1.1.4-dev.4 (the `build=` trace
line) — tm.nahaboo.org may still serve the pre-fix file; (2) `chrome://
bluetooth-internals` on the phone → disconnect/Forget the device there
(browser-process-level cache no page reload clears).

**Holder identified: another Chrome context (v1.1.4-dev.5).** On the phone,
`chrome://bluetooth-internals` shows the COROS as **Connected**, and pressing
disconnect/Forget there changes nothing — Chrome itself (or a background tab /
restored session / installed-PWA window of walkpadspeed in the same browser
process) owns the half-dead GATT connection and instantly re-establishes the
state. This explains everything: our page's `connect()` resolves in 0.2 s
(the ACL exists), `gatt.connected` on our object is false, and every ATT op
hangs because the real owner never answers. Only killing the owner releases
it: **Android Settings > Apps > Chrome > Force stop** (closing tabs is not
enough — Android keeps them alive), close any installed walkpadspeed PWA, or
toggle Bluetooth. Hints/README updated to that recipe. `forget()` cannot help
while another context holds the connection.

**adb breakthrough (2026-11-14 evening).** Wireless-debug adb to the phone gave
the real root causes:
- `logcat` showed Chrome's `BluetoothGatt` calls failing with
  `android.os.DeadObjectException` in `disconnectGatt` — Chrome's Bluetooth
  client was bound to the *previous* Bluetooth-stack instance (stale binder
  after the BT toggle). Settings' Force stop never took; `adb shell am
  force-stop com.android.chrome` did, and right after it the band connected
  for real (fresh ACL 22:50:39, MTU 517, `onSearchComplete status=0`).
- `startNotifications` still never completed: Chrome never issued Android's
  `setCharacteristicNotification` for the band (it does for the walkpad).
- The band does not answer **CCCD reads** (BlueZ only ever *writes* the CCCD,
  which works). The deployed hrmdiag read the CCCD first — that hang wedged
  Chrome's per-device queue and produced `GATT operation already in progress`:
  the diagnostic sabotaged itself. Reordered: subscribe first, probe after.
- The phone was still running **v1.1.4-dev.1** — none of the day's fixes were
  deployed to tm.nahaboo.org. Deploy first, retest second.

**Root cause found via logcat (v1.1.4-dev.6).** During `startNotifications`,
the band pushes **unsolicited notifications at 1 Hz on its vendor-service
characteristics** (`6e400001-…` COROS/NUS, `75f50001-…`). Chrome has no
characteristic wrappers for them (the page only requested `heart_rate`), so
every notification throws `NullPointerException` in
`BluetoothGattCallback.onCharacteristicChanged` (`...Wrapper.a` null) — the
callback thread drowns and the `onDescriptorWrite` for our CCCD write is never
processed → `startNotifications` hangs forever. The band streams this telemetry
whether subscribed or not; BlueZ/Linux never tripped on it because it routes
notifications by handle. Fix: `requestDevice` now declares the band's vendor
services (+ device_information, battery) in `optionalServices`, so Chrome
discovers them, creates wrappers, and silently drops the notifications. Same in
hrmdiag. This also explains why the walkpad (no unsolicited traffic) always
worked. Validation pending on the phone.

**v1.1.4-dev.7: wrapper warm-up.** optionalServices alone did NOT stop the NPE
flood (still 1/s at 23:30 with dev.6 deployed) — Chrome creates Java
characteristic wrappers only when the page *accesses* them. Both app and
hrmdiag now enumerate `getPrimaryServices()` + `getCharacteristics()` on every
service right after connect, before subscribing, so Chrome knows every handle
and drops the band's unsolicited notifications silently. hrmdiag is now
version-stamped (`diag v1.1.4-dev.7` in its log) — always check that line
before trusting a diag run.

**v1.1.4-dev.8: THE root cause, from a clean logcat trace.** After an adb
force-stop + fresh hrmdiag run: `connectGatt` → connected in 0.08 s → MTU 517
OK → `onSearchComplete status=0` → Chrome **does** call
`setCharacteristicNotification(0x2A37, enable)` → HR notifications arrive at
1 Hz immediately → **`onDescriptorWrite` never arrives**. The COROS band
streams heart-rate notifications without ever acknowledging the CCCD write, so
`startNotifications()`'s promise never resolves even though data is flowing.
Every earlier "phantom link / dead binder / NPE flood" theory was a symptom or
a red herring; the NPEs were from the walkpad's own orphan notifications,
unrelated. Fix: race `startNotifications()` against the first
`characteristicvaluechanged` event — a beat proves the subscription works, so
treat it as success (both app and hrmdiag, diag v1.1.4-dev.8).

**End of day 2026-11-14 — state for tomorrow.**
Still failing: `startNotifications` never resolves on the phone (dev.8, fresh
Chrome, single tab, gearhead stopped). Clean logcat shows: connect OK, MTU 517,
`onSearchComplete status=0`, `setCharacteristicNotification(0x2A37)` issued,
notifications arrive at 1 Hz — but **every one NPEs in Chrome's Java layer**
(`BluetoothGattCharacteristicWrapper.a` null) even after the full wrapper
warm-up, and `onDescriptorWrite` never comes. So the band pushes notifications
on a handle Chrome's GATT DB does not know.

**Prime suspect named by Colas: the HR RELAY running on colas** (the phone's
device list shows `HR RELAY` with the colas dongle address AC:A7:F1:3E:2C:0C).
The COROS band serves one central at a time: if the relay (re)connects, the
band is busy streaming there and ignores the phone's CCCD write — matching
"notifications flow but the write is never acked". Tomorrow:
1. Stop the HR RELAY on colas (and its reconnect loop), confirm with
   `bluetoothctl devices` / `menu advertise` that colas advertises nothing,
   then retry the app on the phone.
2. If it still fails: capture raw ATT with `btmon` on colas while the phone
   connects, to see the exact notification handle the band pushes on and
   whether the band answers the CCCD write at all.
adb to the phone works (wireless debugging, pair 10.0.0.217 — re-pair needed
after reboot; `am force-stop com.android.chrome` is the reliable Chrome kill).

**RESOLVED (2026-11-15): Chrome 157 regression; Vivaldi works.** Play Store
confirms Chrome updated 2026-11-11, first failure 2026-11-13. Edge and Vivaldi
show the same hang initially, but **Vivaldi connects after a few retries** —
the NPE wedge is a race (whether the band's first unsolicited notification
beats the wrapper registration), and Vivaldi's older bundled Chromium tolerates
it more often. Workaround: use Vivaldi, re-tap on failure. The hr-relay
(/m-home/colas/git/hr-relay, BLE→BLE re-advertising relay) was built as a
fallback but is NOT needed and NOT running; do not start it. The dev.2–dev.8
HRM changes (phantom-link detection, warm-up, first-beat race, forget()) are
harmless and stay.

---

### Session 2026-11-16: Connections view — visible connect status + trace panel (v1.2.0-dev.5)

Report: on the Connections view, tapping Connect (e.g. to the HR RELAY) failed with
**no visible message** — the failure text went only to `#driverStatus`, which lives in
the hidden driver view. The card lines (`#connPadStatus`/`#connHrmStatus`) are set only
by `updateConnStatus()` to end-states ("Not connected"), so a failed connect looked
silent.

**Fixes:**
- `updateStatus()` now mirrors every message onto a new `#connStatus` line on the
  Connections view, with a red `.conn-error` class when the text matches
  fail/failed/refused/stuck. This is the single funnel for connect progress and errors.
- `connectHRM()` gained an initial "Connecting to the Heart Rate Monitor…" and a
  "No Heart Rate Monitor selected." on `NotFoundError` (previously a silent `return`).
- New `#connDebugPanel` on the Connections view (Copy/Clear + `<pre>`), fed by the same
  `debugLog` as the player's panel; `refreshDebugView()` now fills both panels. Shown
  when `metaDebug || debugEnabled` via `updateConnDebugPanel()`.
- `trace()` and `restoreDebugLog()` now honour `debugEnabled` (the ?dbg/manager toggle),
  not just `metaDebug`, so the trace records on the Connections view too.
- New `applyUrlFlags(urlParams)` restores the t/dbg/eruda flags on a cold load of the
  connections view (the router's connections branch never ran `initManagerMode`, so
  `?view=connections` with a `dbg` flag lost the flags and `showView` stripped `dbg`
  from the URL).

**Test:** `test/nav.test.cjs` case [9] mocks `navigator.bluetooth.requestDevice` to throw
and asserts `#connStatus` shows a "fail" message on the Connections view (verified to
fail without the mirror). `node --check` + `tsc --checkJs` baseline unchanged (36).

**Outcome: the HRM connects through the relay and streams at 1 Hz.** Two separate things
were going on, and only one was a code bug:

- *No visible message* — the app bug above. Fixed in `c052000`.
- *The connection itself* — the relay (`/m-home/colas/git/hr-relay`, systemd user unit
  `hr-relay.service`, `ExecStart` points at the repo binary so `go build -o hr-relay .`
  + `systemctl --user restart` is the whole deploy) was **blind to the phone side**: it
  never registered a connection-state handler, and the tinygo BlueZ backend only starts
  its D-Bus signal loop if a handler exists *before* `adv.Start()`. Added it
  (`hr-relay` `1c33de1`), then filtered the phantom `client dropped:` lines BlueZ emits
  for devices merely discovered while scanning — only a drop of an address that had
  connected is real (`c43d358`). The relay restart is the likely reason the connect
  started working (fresh advertisement; the resume-watch exists because the
  advertisement dies silently across suspend/resume), but that is inference, not proven.

**Correction to the 2026-11-15 note above:** the relay is now **running and is the
working path** for the COROS strap from Chrome on the phone — it is not "not needed".
`hr-relay-resume-watch` restarts it on resume. Diagnostic one-liner:
`journalctl --user -u hr-relay.service -n 20 -o cat` — `client connected:` means the
phone reached the relay (so a failure is in the app's GATT/subscribe path); silence
means the phone never got there (scan/advertisement side).

---

### Session 2026-11-20: LAN HR transport, relay scan-wedge fix, HRM auto-reconnect (v1.2.0-dev.8)

Multi-model planning (`plans/002-*.md`), then implementation. Root evidence:
the 2026-11-19 journal shows the phone→relay ACL dying 25–58 s after each
connect (six attempts), the relay forwarding `HR … bpm` through every drop —
so the fragile leg is phone↔relay BLE, not the strap. The relay's own central
loop was wedged 1140× on `scan: Operation already in progress` (per-attempt
`adapter.Scan` races the previous non-cancellable one).

**hr-relay** (`3154391`, `9b60b90`, deployed + restarted):
- Single long-lived scan (one goroutine, advertisements → channel); the
  StopScan/Scan race is gone. Watchdog: no scan result AND no scan restart
  for `-watchdog-secs` (600) → `log.Fatal` → systemd restart (a wedged BlueZ
  scan cannot be cancelled any other way). `-stale-secs` 60 → 300. Strap ACL
  logged as `sensor link lost (ACL)`, phones as `phone client connected:`.
- Opt-in LAN API (`httpapi.go`): `GET /api/v1/hr` JSON snapshot
  `{relayId, version, sensorConnected, bpm, sampleSeq, sampleAgeMs,
  forwardErrors, lastForwardOkMs}`. Enabled only with `-http <lan-addr>`
  (refuses 0.0.0.0 without `-allow-any-bind`) + `HR_RELAY_HTTP_TOKEN`
  (constant-time compare) + `-http-origin` (exact CORS origin, Max-Age 600).
  `relayId` is random per process — mandatory: `sampleSeq` restarts at 1 on
  relay restart and would freeze a seq-only dedupe. `version` via
  `-ldflags "-X main.version=$(git rev-parse --short HEAD)"`. `main_test.go`
  covers fresh/stale/no-sample/seq/auth/CORS/config. **Not yet enabled**:
  needs the systemd unit to pass `-http`/`-http-origin` + the token env.
- Windows (`games` host) ruled out: TinyGo peripheral/GATT-server support is
  BlueZ-only in practice; not worth a WinRT rewrite.

**walkpadspeed** (`e9239c9`, `f11d820`):
- **HRM auto-reconnect**: `gattserverdisconnected` → up to 3 reconnects
  (2/4/8 s) via `armHrmLink()` unless user-disconnected; separate counter
  from `hrmFailCount` (never triggers the RELOAD hint); `trace('HRM user
  disconnect')`; retry on `visibilitychange`. Fixes the "one drop costs the
  session" gap.
- **LAN HR transport**: Connections-view card (endpoint → localStorage
  `wpss_lan_hr_url`, token → sessionStorage only). `hrTransport`
  (`null|ble|lan|test`); `hrmConnected()` is now the availability predicate
  at all zone/session guard sites (`hrmCharacteristic` stays the BLE object).
  `processHrSample()` = one BPM pipeline for both transports. 1 Hz serialized
  `setTimeout` poll, 3 s abort timeout, dedupe on `(relayId, sampleSeq)`,
  stale (`sensorConnected:false` / age>5 s / frozen seq) → `currentHeartRate=0`
  + trend reset but **`hrmStepTargetZone` stays armed** (clearing it would
  permanently disarm control). `addressSpaceFor()` → `'loopback'` for
  localhost, `'local'` for RFC1918 (Chrome LNA verifies the resolved space).
  Network errors back off to 5 s, never touch `hrmFailCount`; 401 stops
  polling visibly. `targetAddressSpace` passed via `/** @type {any} */` init
  to keep the tsc baseline at 36.
- `test/hrm-lan.test.cjs` (24 checks, mock fetch). Full suite green.

**Pending (user)**: enable `-http` on the systemd unit, run the phone LNA
reachability gate (plan 001 step 4) from the real HTTPS origin, then the
end-to-end run. If LNA blocks, fallback is option E: serve app+API
same-origin HTTPS from the relay (ACME DNS-01).
