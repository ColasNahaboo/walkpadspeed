## walkpadspeed — Project & Session Summary

### What the project is

`walkpadspeed` is a **single-file HTML web app** (`walkpadspeed.html`) for controlling Bluetooth walking pads and treadmills via the Web Bluetooth FTMS protocol. It lives at [github.com/ColasNahaboo/walkpadspeed](https://github.com/ColasNahaboo/walkpadspeed). There is no build system, no framework, no server — everything is one self-contained HTML file with inline CSS and JS. The current version is **v0.7.5**.

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

`metaName`, `metaBirthYear`, `metaWeight`, `metaRestHeartRate`, `metaMaxHeartRate`, `metaSpeedUnit`, `metaFileVersion`, `metaIncline`

`parseMetadata` is called both in the manager (on file load) and in `initDriverMode` (re-parses from `localStorage` cache since page navigation resets JS globals).

---

### HR Zone system

Uses **Karvonen / Heart Rate Reserve** method. Requires `#rest-heart-rate` and `#max-heart-rate` in the routines file.

```javascript
const ZONE_BOUNDARIES = {
    0: [0.35, 0.50],   // Z0  digestive    turquoise
    1: [0.50, 0.60],   // Z1  recovery     blue
    2: [0.60, 0.70],   // Z2  aerobic      green
    3: [0.70, 0.80],   // Z3  endurance    yellow
    4: [0.80, 0.90],   // Z4  threshold    orange
    5: [0.90, 1.00],   // Z5  VO2 max      red (flashes at maxHR)
};
```

`getHRZone(bpm)` returns 0–5 or null. `getZoneBpmBounds(zone)` returns `{low, high}` BPM for a zone number.

---

### HRM (Heart Rate Monitor) feature

Standard BLE Heart Rate Profile (`service 0x180D`, characteristic `0x2A37`, Notify). Implemented as:

- **`connectHRM()`** — BLE device picker filtered by `heart_rate` service
- **`disconnectHRM()`** — clean disconnect
- **`handleHrmNotification(event)`** — parses flags byte (uint8 vs uint16 HR value), stores `currentHeartRate`, calls `updateHrmUI` + `updateHrZone`
- **`updateHrmUI(state, bpm)`** — toggles the HR metric box between connect/connecting/connected states
- **`updateHrZone(bpm)`** — updates zone display, background color, max-HR flash animation, mercury pillars, and calls `applyHrmZoneAdjust()` on zone change
- **`updateHrmPillars(bpm, zone)`** — drives the mercury visualizer

**Zone-change trigger**: `lastHrZone` global tracks the previous zone. When `getHRZone(bpm) !== lastHrZone`, `applyHrmZoneAdjust()` fires immediately (in addition to the 30s interval).

---

### Zone-targeted speed control (`X/Zn` steps)

When a step has a `targetZone` and HRM is connected:

**`enterStepSpeed(step, isInitialStart)`** — called instead of raw `sendSpeed` at step transitions. If HR is already within the target zone bounds, skips `sendSpeed` entirely (keeps current belt speed as baseline). Otherwise sends the stated fallback speed.

**`startHrmZoneControl(zone)`** — starts the adjustment loop:
1. Calls `applyHrmZoneAdjust()` immediately
2. Sets `setInterval(applyHrmZoneAdjust, 30000)` (30s — chosen over 15s to avoid oscillation; HR takes 30–60s to respond to speed changes)

**`stopHrmZoneControl()`** — clears the interval, nulls `hrmStepTargetZone`

**`applyHrmZoneAdjust()`** — runs every 30s and on zone changes:
- Guards: `!isRoutineActive || isPaused`, `hrmStepTargetZone === null`, `currentHeartRate <= 0`, `lastHrmZoneAdjust` < 15s ago
- **Asymmetric step sizes** (below zone is less dangerous than above): below zone: +0.1/+0.2/+0.3 km/h for <5/5–10/>10 BPM deficit; above zone: −0.1/−0.1/−0.2 km/h (more conservative going down)
- Clamps speed to [0.5, 20.0] km/h
- Sets `lastHrmZoneAdjust = Date.now()` and `currentTargetSpeed = newSpeed` before calling `sendSpeed`

Zone control lifecycle: starts at routine-start / step-transition / RESUME (app button and physical remote); stops at PAUSE / STOP / step-end via `clearAllIntervals()` which includes `stopHrmZoneControl()`.

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
