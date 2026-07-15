## walkpadspeed — Project & Session Summary

### What the project is

`walkpadspeed` is a **single-file HTML web app** (`walkpadspeed.html`) for controlling Bluetooth walking pads and treadmills via the Web Bluetooth FTMS protocol. It lives at [github.com/ColasNahaboo/walkpadspeed](https://github.com/ColasNahaboo/walkpadspeed). There is no build system, no framework, no server — everything is one self-contained HTML file with inline CSS and JS. The current version is **v0.8.2**.

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

`metaName`, `metaBirthYear`, `metaWeight`, `metaRestHeartRate`, `metaMaxHeartRate`, `metaSpeedUnit`, `metaFileVersion`, `metaIncline`, `metaHRM` (set to 0 by `#hrm: 0` to hide the HR metric UI; default 1)

`parseMetadata` is called both in the manager (on file load) and in `initDriverMode` (re-parses from `localStorage` cache since page navigation resets JS globals).

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

**Zone-change trigger**: `lastHrZone` global tracks the previous zone. When `getHRZone(bpm) !== lastHrZone`, `applyHrmZoneAdjust()` fires immediately (in addition to the 20 s interval).

---

### Zone-targeted speed control (`X/Zn` steps)

When a step has a `targetZone` and HRM is connected:

**`enterStepSpeed(step, isInitialStart)`** — called instead of raw `sendSpeed` at step transitions. If HR is already within the target zone bounds, skips `sendSpeed` entirely (keeps current belt speed as baseline). Otherwise sends the stated fallback speed.

**`startHrmZoneControl(zone)`** — starts the adjustment loop:
1. Calls `applyHrmZoneAdjust()` immediately
2. Sets `setInterval(applyHrmZoneAdjust, HRM_ZONE_INTERVAL_MS)` where `HRM_ZONE_INTERVAL_MS = 20000` (20 s). The min spacing between actual adjustments is `HRM_ZONE_MIN_MS = 10000` (10 s) — protects against the zone-change trigger re-firing too fast.

**`stopHrmZoneControl()`** — clears the interval, nulls `hrmStepTargetZone`

**`applyHrmZoneAdjust()`** — runs every 20 s and on zone changes:
- Guards: `!isRoutineActive || isPaused`, `hrmStepTargetZone === null`, `currentHeartRate <= 0`, `lastHrmZoneAdjust` < 10 s ago
- Delegates the speed-delta decision to `calculateSpeedAdjustment(currentHR, zoneLow, zoneHigh)` (see "HR zone controller tuning" below)
- Clamps speed to `[HRM_SPEED_MIN, HRM_SPEED_MAX]` = `[0.5, 20.0]` km/h
- Sets `lastHrmZoneAdjust = Date.now()` and `currentTargetSpeed = newSpeed` before calling `sendSpeed`

Zone control lifecycle: starts at routine-start / step-transition / RESUME (app button and physical remote); stops at PAUSE / STOP / step-end via `clearAllIntervals()` which includes `stopHrmZoneControl()`.

---

### HR zone controller tuning (`HR_CONTROL_CONFIG` + `calculateSpeedAdjustment`)

The zone controller has two phases, both driven by the `HR_CONTROL_CONFIG` constants:

| Parameter | v0.7 value | v0.8.2 value | Why |
|---|---|---|---|
| `emaAlpha` | 0.3 | 0.2 | EMA smoothing for the HR trend (BPM/s). Was sticky: ramp-up momentum persisted for several ticks after HR plateaued, causing premature `nudgeDown`. 0.2 lets the trend decay in ~3 intervals. |
| `lookaheadSeconds` | 30 | 20 | How far ahead to project `projectedHr = currentHr + trend * lookaheadSeconds`. **Must not exceed `HRM_ZONE_INTERVAL_MS`** — if it does, the controller projects past the next check and self-induces oscillation. Matched at 20 s. |
| `maxSpeedChange` | 0.5 | 0.5 | Hard clamp on a single PHASE 1 (acquisition) adjustment. |
| `proportionalGain` | 0.05 | 0.05 | km/h per BPM of error from zone center (PHASE 1 only). |
| `brakeThreshold` | 0.3 | 0.4 | BPM/s velocity at which the D-controller says "the body is catching up, hold steady". Logged HR moves are mostly <0.3 BPM/s; the old value triggered the brake during normal drift. |
| `nudgeDown` | -0.4 | -0.2 | PHASE 2 (maintenance) nudge when HR is in the outer half and projected to escape the top. |
| `nudgeUp` | +0.1 | +0.2 | PHASE 2 nudge when projected to escape the bottom. **Now symmetric** with `nudgeDown` — the old 4:1 down-favoured ratio was right for Z0 but trapped HR in Z1 on Z2 work (5–6 intervals to climb back vs 1–2 to cut). |

**`updateHrTrend(currentHr)`** — EMA over per-tick BPM/s; stores `lastSmoothedTrend`, `lastHr`, `lastTimestamp`.

**`calculateSpeedAdjustment(currentHr, zoneLow, zoneHigh)`** — two phases:

- **PHASE 1 — Acquisition (HR outside zone bounds).** Proportional: `errorFromCenter * proportionalGain`, clamped to `±maxSpeedChange`. Then a D-controller brake: if HR is below the zone but rising fast (`trend > brakeThreshold`), or above but dropping fast, return 0 (coast — body is catching up).

- **PHASE 2 — Maintenance (HR inside zone bounds).** Central 50% of the zone is a deadband (`zoneRange / 4` on each side of center) → return 0. In the outer halves, project HR by `lookaheadSeconds`. If projected above `zoneHigh`, return `nudgeDown` (boosted ×1.5 if `trend > brakeThreshold`); if projected below `zoneLow`, return `nudgeUp` (boosted ×1.5 if `trend < -brakeThreshold`). The ×1.5 boost ports the D-controller idea into maintenance — without it, a fast fall through the lower third of the zone can't be arrested before Z1 is entered.

**Oscillation failure mode (v0.7 → v0.8.1 logs, `Z2 40mn` step 4):** HR oscillated between Z1 and Z3 in a 2–4 min cycle while speed swung through a ~1.5 km/h band centered on the Z2 midpoint. Three interacting causes: (1) the 4:1 down-favoured nudge ratio kept recovery from Z1 slow; (2) `emaAlpha=0.3` + `lookaheadSeconds=30` > `HRM_ZONE_INTERVAL_MS` projected ramp momentum past the next check and cut speed preemptively; (3) PHASE 2 had no trend-aware brake — a fixed +0.1 couldn't arrest a fast fall. Z0 ("Short Digestive") control worked fine in the same logs because the strong `nudgeDown` matched its "don't escape upward" intent.

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

Markdown log of each workout session, stored in `localStorage` under `wpss_session_log`. Entries prepended (newest first). Each entry records: date/time, routine name, start step (if not from beginning), elapsed time, completion status, and speed modifier history. Accessible via "View Session Log" button in Manager view with Copy and Clear actions.

---

### Remote pause/resume detection

The walkpad's physical remote is detected via BLE speed notifications. `stopDetectThreshold()` = `minSpeed * speedThreshold` where `minSpeed` is the routine's slowest step speed and `speedThreshold = 0.8`. This prevents false positives when the slowest step speed equals the jitter threshold (previously caused pause/resume flickering at 2.0 km/h steps).

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
