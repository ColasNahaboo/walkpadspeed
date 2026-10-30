# Hardware notes — pads tested with walkpadspeed

Field notes on the Bluetooth walking pads and treadmills this app has been driven on,
what each one actually implements of the FTMS protocol, and which firmware quirks cost
us a bug. Read this before changing `handleTreadmillData()`, the control-point layer or
the speed-cap logic: every rule in there exists because of something on this page.

Nothing here is a manufacturer document — it is all observed behaviour, captured with
the app's own debug trace (`#debug: 1` or `?dbg=1`) and, for the W60, a BLE scanner.

| Pad | Type | Speed | Incline | Verified against | State |
|---|---|---|---|---|---|
| Fousae ZX-390 (and clones) | walking pad, speed only | 1.00–6.00 km/h | none (manual, fixed) | v1.0.2, v1.1.1 | works |
| Merach UltraWalk W60 | treadmill with motorised incline | 1.00–6.00 km/h | 0–12 % motorised | v1.1.0 | works |

---

## 1. Capturing a new pad

1. **Chrome needs the flag on Linux.** `navigator.bluetooth` is not exposed by default,
   even in a secure context: launch with `--enable-features=WebBluetooth`. Phone Chrome
   needs nothing.
2. **One central at a time.** A pad already connected to its phone app stops
   advertising and becomes invisible to every scanner, including the browser's picker.
3. Add `#debug: 1` to the routines file (or append `?dbg=1` to the player URL), connect,
   run a short routine with at least two speeds, and copy the "Debug log" panel. The
   buffer is mirrored to `localStorage` (`wpss_debug_log`, last 800 lines) so a reload
   does not lose the capture.
4. Read the trace in this order:

| Trace line | What it tells you |
|---|---|
| `CONNECT <name> id=…` | the advertised name — useful to identify the model |
| `CP indication op 0x… → Success` | the pad answers the control point (or not: `CONTROL no indication`) |
| `CONTROL acquired` / `refused` | it needs `Request Control` (0x00) before accepting targets |
| `RANGE 0x2AD4: speed a–b km/h (inc c) [hex]` | supported speed range, with the raw bytes |
| `RANGE … implausible, ignored` | a characteristic that reads nonsense — see §5 |
| `RANGE incline a–b %` | whether the incline range (0x2AD5) is exposed |
| `STATUS <name>` | the pad's own events (0x2ADA): start/stop by the user, target changes |
| `DATA flags=0x… speed=… incline=…` | one line per Treadmill Data frame that changes something |
| `DATA flags=0x1 continuation frame ignored` | the "More Data" quirk — see §3 |
| `CP → set speed 3.0 km/h [02 2c 01]` | the exact frame sent, so you can compare with what the belt does |

Then fill in the template in §6 and, if the pad needed new code, add the rule to §5
with a pointer to the commit.

---

## 2. FTMS baseline

The app speaks only standard FTMS (`0x1826`) — no vendor protocol is implemented,
because none has been needed yet.

| Characteristic | Role in the app |
|---|---|
| `0x2AD9` Machine Control Point (write + indicate) | `0x00` Request Control, `0x02` Set Target Speed, `0x03` Set Target Incline, `0x07` Start/Resume, `0x08` Stop/Pause with parameter `0x01` stop / `0x02` pause |
| `0x2ACD` Treadmill Data (notify) | instantaneous speed (mandatory), inclination from flag bit 3; flags bit 0 "More Data" is advisory — see §5 |
| `0x2ADA` Fitness Machine Status (notify) | `0x01` reset, `0x02` stopped/paused by the user, `0x03` started/resumed by the user, `0x04` target speed changed, `0x05` target incline changed, `0xFF` control lost |
| `0x2AD4` Supported Speed Range (read) | minimum, maximum, minimum increment — becomes the speed cap |
| `0x2AD1` Supported Speed Range, deprecated | same layout, older pads only; probed second |
| `0x2AD5` Supported Inclination Range (read) | clamps incline commands to what the deck can do |
| `0x2ACC` Fitness Machine Feature (read) | not read by the app; used with an external scanner to see which target-setting features a pad claims |

Resolutions: speed `uint16` at 0.01 km/h, incline `sint16` at 0.1 %, speed range fields
`uint16` at 0.01 km/h, incline range fields `uint16` at 0.1 %. In the control point,
Set Target Speed is `uint16` at 0.01 km/h and Set Target Incline is `sint16` at 0.1 %,
so 3.0 km/h is `02 2c 01` and 9 % is `03 5a 00`.

Two structural consequences worth remembering:

- **Speed 0 is not a valid target speed.** It is below every pad's minimum, so pause
  and stop must use `0x08` with its mandatory parameter. The historical "send speed 0"
  trick is kept only as a fallback for pads that ignore `0x08`.
- **A pad can refuse a command.** When the pad indicates, the app reads the result and
  reports `Pad refused 3.0 km/h (Operation failed)` instead of pretending success.

---

## 3. Fousae ZX-390 (walking pad, speed only)

Sold under many brands (Urevo, Sperax, DeerRun, Costway…). The app's original test pad.
Entry-level: a belt, a speed motor, a manual incline you set by hand and no sensors.

**Identity.** Advertised as `FS-<serial>` (observed `FS-9C3638`).

**What it exposes** (v1.1.1, 2026-10-30):

| Item | Observation |
|---|---|
| Control point `0x2AD9` | answers with indications: `op 0x0 → Success`, `0x2 → Success`, `0x7 → Success`, `0x8 → Success` |
| Request Control `0x00` | accepted (granted) — but the pad also accepts targets without it |
| Supported Speed Range `0x2AD4` | `1.00–6.00 km/h`, minimum increment `0.10` — raw `[64 00 58 02 0a 00]` |
| Supported Speed Range `0x2AD1` | unknown: v1.0.2 read it (and the routines file also carried `#max-speed: 6`), so we cannot tell whether it exists |
| Supported Inclination Range `0x2AD5` | not readable — the pad has no motorised incline |
| Treadmill Data `0x2ACD` | two frames per second, flags `0x0008` on the speed frame (inclination present), see below |
| Fitness Machine Status `0x2ADA` | sends `0x04 Target speed changed` and `0x02 Machine stopped or paused (by the user)` |

**Speed behaviour.**
- Accepting Start starts the belt at its own minimum, **1.0 km/h**, immediately; the app
  then waits its 5 s spin-up and sends the step speed. (The pad announces this on its own
  with two `STATUS Target speed changed` events before the app has sent anything.)
- The belt ramps to a target instead of jumping: 3.5 → 0 took about 7 s, one 0.5 km/h
  step per frame (3.1, 2.6, 2.1, 1.6, 1.1, 0.1, 0.0 km/h).
- Minimum usable speed is 1.0 km/h, so `#min-speed: 1` matches the hardware (and is the
  default anyway). Speeds below that are not reachable.

**The data stream quirk (this one caused two bugs).** The pad sends *two* Treadmill Data
frames per second:

```
14.9s DATA flags=0x8 speed=3.0 incline=0.0%   ← complete frame: speed + inclination
14.9s DATA flags=0x1 speed=0.0               ← continuation: no speed field at all
16.9s DATA flags=0x1 speed=0.1                  its first bytes are a cumulative
45.8s DATA flags=0x1 speed=0.2                  total (distance/energy) that reads
62.8s DATA flags=0x1 speed=0.3                  as 0.10, 0.20, 0.30 … km/h
```

The continuation frame has flag bit 0 ("More Data") set and **must not be read as a
speed frame**. When the app did read it (v1.1.0):
- the live speed metric showed 0.1, 0.2, 0.3 … while the belt ran happily at 3.0, which
  looked exactly like "the speed was divided by ten";
- every one of those frames is below `speedMinThreshold`, so it armed the remote-pause
  detector. The alternating good frames normally cancelled it, but at a step change the
  app suppresses those checks for 7 s — the armed timer then fired on a stale 0.3 km/h
  and paused the routine mid-step, with the belt still running. That is the "timer stuck
  at 00:59" report.

v1.0.2 skipped flag-bit-0 frames unconditionally, which is why this pad worked then and
the W60 did not. The current rule is adaptive — see §5.

**Incline.** There is none, but the pad still sets the inclination-present bit in its
Treadmill Data and reports `0.0 %`. Consequences: `currentLiveIncline` becomes `0.0`
(not `null`), so `sendIncline()` short-circuits on 0 % and no `0x03` frame is ever sent —
provided the routine has no `X%` token and no `#incline:`. Do not put incline tokens in a
routine meant for this pad: the pad answers "OpCode not supported", the status says so,
and the start of the routine waits out the 7 s deck-stall timeout for a deck that will
never move.

**Remote.** The physical remote stops and starts the belt. A remote start puts the belt
at its minimum, **1.0 km/h** — exactly the pause threshold, which is why resume detection
is inclusive (`>= speedMinThreshold`, not `>`); the app then re-sends the step speed.

**Routine settings.** `#min-speed: 1`, `#max-speed: 6` (both are also what the pad
reports), no `X%` tokens, no `#incline:`.

---

## 4. Merach UltraWalk W60 (treadmill with motorised incline)

**Identity.** Advertised as `MR-W60.2-<serial>` with a **random (non-resolvable)
address**; the same chassis also advertises a separate classic-audio endpoint named
`W60.2-<serial>_Audio`, which is *not* the FTMS endpoint. Pick the `MR-W60…` entry.

**What it exposes:**

| Item | Observation |
|---|---|
| Control point `0x2AD9` | indicates; **requires `Request Control` (0x00)** before accepting a target |
| Supported Speed Range `0x2AD4` | `1.00–6.00 km/h`, minimum increment `0.10` |
| Supported Speed Range `0x2AD1` | absent (the read fails silently — this is what used to leave the cap at 12 km/h) |
| Supported Inclination Range `0x2AD5` | `0–12 %` |
| Fitness Machine Feature `0x2ACC` | target-setting features: speed + incline |
| Treadmill Data `0x2ACD` | flags bit 0 set on **every** frame, which still carries a valid speed |
| Vendor service `0xFFF0` | `0xFFF1` notify, `0xFFF2` write; an undocumented `d18d2c10-…` write characteristic |
| Fitness Machine Status `0x2ADA` | sends start/stop and target-change events |

The vendor channel is **not needed**: speed and incline both work over plain FTMS, and
incline works over `0x03` (9 % verified). An earlier note claiming an "encrypted Merach
handshake" was wrong.

**Control point.** Without `Request Control`, the pad beeps twice and keeps its own
1.0 km/h while the app reports success. With it, `0x02`, `0x03`, `0x07` and `0x08` all
work and are answered.

**Incline sequencing rules** (learned the hard way; implemented in `enterStepSpeed()`):
1. An incline target sent while the machine is idle is ignored. Start first.
2. A target incline sent before any target speed is set is also ignored — the pad keeps
   1.0 km/h and the deck stays at 0 %, so the app sends speed first, then incline.
3. The deck takes 15–20 s for 0 → 9 %, and **the belt is suspended while it travels**.
   The app therefore raises the deck on the first step, waits for the reported incline to
   settle (`waitForInclineSettle()`), and only then lets the routine clock start.
4. While the deck moves, the pad **drops the speed target** and falls back to 1.0 km/h:
   the speed is re-asserted once the incline is in place (`reassertSpeedAfterIncline()`).
5. Redundant incline commands are skipped — each one stutters the belt.
6. On stop the pad returns the deck to 0 %.

**Belt watchdogs.** If the app sends a speed and the belt never engages (safety key, user
detection), `scheduleBeltStartCheck()` says so in the status line instead of the clock
running over a stationary belt.

**Routine settings.** `#max-speed: 6` (or rely on the pad's own range), incline via `X%`
tokens or a file-wide `#incline:`. An incline-only first step costs the deck travel time
(up to ~20 s) before the routine clock starts.

---

## 5. Cross-pad rules (why the code looks the way it does)

- **Never trust a pad-reported maximum blindly.** A Supported Speed Range reading is only
  used when its maximum is plausible (1.5–30 km/h), otherwise `#max-speed` or the 12 km/h
  default applies and the rejection is traced with the raw bytes
  (`readPadSpeedRange()`). Both characteristics are probed, not just the first that
  exists. A wrong cap is invisible — it silently scales every speed.
- **Say when a speed is capped.** `sendSpeed()` reports `Speed 5.5 km/h limited to 3.0
  km/h (pad maximum)` rather than hiding the clamp. A silent cap is what makes a pad look
  like it has a unit-conversion bug.
- **Flag bit 0 is "More Data", and pads disagree about it.** It is treated as "this frame
  has no speed field" *only once the same pad has been seen clearing it*: the Fousae sets
  it on its second, speedless frame, the W60 sets it on every valid frame. Do not make
  this unconditional in either direction — both pads are in daily use.
- **Treadmill Data flags** must be parsed in order and each optional field skipped by its
  bit; a field the pad claims but does not send is a length check away from garbage.
- **Pause/Stop use `0x08` + parameter**; speed 0 is an invalid parameter on compliant
  pads and is only a fallback.
- **Remote resume is inclusive**: a pad resumed from its physical remote restores its own
  minimum speed, which equals `speedMinThreshold`.
- **Our own commands cancel the pending remote-pause detection**
  (`cancelRemotePauseDebounce()`), otherwise a frame from just before a step change pauses
  the routine 1.5 s later.
- **`currentLiveIncline` is advisory**: some pads (Fousae) report 0 % without having an
  incline, some (W60) hold the belt while the deck moves. Never block the clock on it
  without a stall timeout.
- **One central at a time.** A pad connected to its phone stops advertising; the app
  cannot see it.

---

## 6. Template for a new pad

Copy this into §3/§4 when testing a new machine, and add the model to the table at the
top of the file.

```markdown
### <Brand> <Model> (<type: walking pad / treadmill>)

**Identity.** advertised name `…`, address type (public / random), audio or other
endpoints to avoid, phone app name.

**Exposed characteristics**

| Item | Observation |
|---|---|
| Control point `0x2AD9` | indicates? requires Request Control? which opcodes answer Success? |
| `0x2AD4` / `0x2AD1` | speed range + increment, raw bytes |
| `0x2AD5` | incline range, or "not readable" |
| `0x2ACC` | target-setting features (speed / incline / resistance …) |
| `0x2ACD` | frames per second, flags seen, does it carry speed in every frame? |
| `0x2ADA` | which status events it actually sends |
| vendor services | UUIDs, whether they are needed |

**Speed behaviour.** default speed on start, ramp time, reachable min/max, what happens
on stop, does it keep or drop the target when paused.

**Incline behaviour.** does it need Start first, does it suspend the belt, does it drop
the speed target, does it reset on stop, settle time for a 0→N % move.

**Quirks that broke something.** symptom → cause → code that handles it.

**Routine settings.** recommended `#min-speed` / `#max-speed` / `#incline` for this pad.
```
