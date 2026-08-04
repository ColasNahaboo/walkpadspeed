## walkpadspeed — Project & Session Summary

### What the project is

`walkpadspeed` is a **single-file HTML web app** (`walkpadspeed.html`) for controlling Bluetooth walking pads and treadmills via the Web Bluetooth FTMS protocol. It lives at [github.com/ColasNahaboo/walkpadspeed](https://github.com/ColasNahaboo/walkpadspeed). There is no build system, no framework, no server — everything is one self-contained HTML file with inline CSS and JS. The current version is **v0.9.0-dev.6**.

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
#incline: 6               # fixed treadmill incline (suppresses incline metric)
#max-speed: 8             # fallback pad max-speed cap when BLE 0x2AD1 unreadable (default 12)
#min-speed: 0.5           # fallback pad min-speed floor when BLE 0x2AD1 unreadable (default 1.0)
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

`metaName`, `metaBirthYear`, `metaWeight`, `metaRestHeartRate`, `metaMaxHeartRate`, `metaSpeedUnit`, `metaFileVersion`, `metaIncline`, `metaMaxSpeed` (optional cap when the pad's BLE 0x2AD1 max is unreadable; default 12), `metaMinSpeed` (optional floor when the pad's BLE min is unreadable; default null), `metaHRM` (set to 0 by `#hrm: 0` to hide the HR metric UI; default 1), `metaStepLength` (step length in meters at 3 km/h; default 0.7)

`parseMetadata` is called both in the manager (on file load) and in `initDriverMode` (re-parses from `localStorage` cache since page navigation resets JS globals).

**Speed-cap globals**: `bleMinSpeed`, `bleMaxSpeed`, `bleMinIncrement` (km/h, read from FTMS Supported Speed Range characteristic `0x2AD1` on connect — see "Pad max-speed cap" below; `bleMinSpeed`/`bleMinIncrement` are stored but not yet used); `metaMaxSpeed` (file override); `maxSpeedLimit` (effective cap, resolved by `updateMaxSpeedLimit()` from BLE value → file override → `DEFAULT_MAX_SPEED = 12`).

---

### HR Zone system

Uses **Karvonen / Heart Rate Reserve** method. Requires `#rest-heart-rate` and `#max-heart-rate` in the routines file.

```javascript
const ZONE_BOUNDARIES = {
    0: [0.38, 0.50],   // Z0  digestive    purple
    1: [0.50, 0.60],   // Z1  recovery     blue
    2: [0.60, 0.70],   // Z2  aerobic      green
    3: [0.70, 0.80],   // Z3  endurance    yellow
    4: [0.80, 0.90],   // Z4  threshold    orange
    5: [0.90, 1.00],   // Z5  VO2 max      red (flashes at maxHR)
};
```

`getHRZone(bpm)` returns 0–5 or null. `getZoneBpmBounds(zone)` returns `{low, high}` BPM for a zone number (**integer-rounded** via `Math.round`).

> **Single source of truth (fixed 2026-07-15):** `getHRZone` now derives its bounds from `getZoneBpmBounds` rather than recomputing them from the raw `ZONE_BOUNDARIES` floats. Previously a BPM near a zone boundary could be labeled one zone (for the on-screen label / pillar color) while being treated as a *different* zone by the speed control math — e.g. with `restHR=70 / maxHR=154`, BPM=120 was labeled Z1 but counted as inside Z2. Both functions now agree on every integer BPM. Overlap at a shared boundary BPM resolves to the higher zone (unchanged behaviour).

---

### HRM (Heart Rate Monitor) feature

Standard BLE Heart Rate Profile (`service 0x180D`, characteristic `0x2A37`, Notify). Implemented as:

- **`connectHRM()`** — BLE device picker filtered by `heart_rate` service
- **`disconnectHRM()`** — clean disconnect
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

---

### Other notable features

- **Step-jump list**: shown when routine is idle/stopped; tapping a step positions the routine there in paused state with all widgets updated. RESUME then starts from that point.
- **Modifier buttons** (`--- -- - = + ++ +++`): apply ±5/10/20% speed multiplier; fires `sendSpeed` immediately when clicked mid-routine.
- **GitHub Gist loading**: "Load Gist from Clipboard" button reads clipboard, extracts gist ID via regex (handles normal/raw/anonymous URLs), fetches via GitHub REST API (CORS-safe), parses as routines file, and sets `?gist=<id>` in URL for bookmarking.
- **Incline support**: FTMS opcode `0x03`, signed 16-bit at 0.1% resolution. `routineHasIncline` tracks whether any step has explicit incline; `metaIncline` suppresses the incline metric when a fixed treadmill incline is declared in metadata.
- **Wake lock**: screen kept on during active workout via `navigator.wakeLock.request('screen')`. Bug fix: also acquired on non-standard start paths (step-jump → resume).

---

### Collaboration style notes (important for next agent)

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

When `#incline: N` was set in the routines file's metadata (which suppresses the fixed-incline metric from the UI per design), the `!metaIncline` guard in the connect path also blocked the metric from appearing when per-step inline `X%` incline overrides existed in the packed URL. The fix removes `!metaIncline` from the two `classList.remove('metric-off')` calls (test-mode connect and BLE connect paths) so `routineHasIncline` alone controls visibility. The `#incline:` metadata still suppresses the metric when all steps use the implicit default.

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
