# walkpadspeed
<img src="doc/walkpadspeed.svg" align="right" width="256" height="256">A simple HTML page web app to program the speed intervals of walking pad workouts

A lightweight, offline-capable dark mode web dashboard to control FTMS (Fitness Machine Service) Bluetooth-enabled walking pads and treadmills. Built with plain HTML, CSS, and modern vanilla JavaScript.

## Features

- **Bluetooth FTMS Integration:** Connects directly via Web Bluetooth API to native Fitness Machine Service characteristics (`0x1826`).
- **Dynamic URL Routines (`?r=`)**: Configure custom interval training profiles directly in the URL bar, complete with speeds, durations, and descriptive step names.
- **Persistent Screen State:** Leverages the modern Browser Screen Wake Lock API to prevent devices from dimming or going blank during workouts.
- **Audio Cues:** Features low-latency predictive audio chime indicators generated via the Web Audio API precisely 1 second prior to interval changes.
- **Precise Timer Mechanics:** High-accuracy state machine managing active countdown intervals, automated variable motor warm-up delays (`spinUpTime`), and live metric tracking.

## URL Parameters (Routine Configuration)

You can launch automated custom workouts by passing URL parameters (`r` for the routine blueprint and `n` for the routine name). 

### Format Blueprint
```text
?n=Routine_Name&r=Speed-Duration-Step_Name,Speed-Duration-Step_Name,...

```

* **Spaces:** Use underscores (`_`) in your strings; they will be parsed and displayed automatically as spaces in the UI.
* **Hyphens:** Step names safely support custom hyphens (e.g., `step-2`).

### Example Configuration

```text
[https://colasnahaboo.github.io/walkpadspeed/?n=Fat_Burn&r=3.0-10-Warm_Up,4.5-15-Interval-1,6.0-120-Last_Effort](https://colasnahaboo.github.io/walkpadspeed/?n=Fat_Burn&r=3.0-10-Warm_Up,4.5-15-Interval-1,6.0-120-Last_Effort)

```

The query string above automatically creates a 3-step sequence:

1. **Warm Up**: `3.0 km/h` for 10 seconds.
2. **Interval-1**: `4.5 km/h` for 15 seconds.
3. **Last Effort**: `6.0 km/h` for 120 seconds.

## Hardware Support & Core Blueprint

This control system operates across standard FTMS profile architectures:

* **Service UUID:** `0x1826` (Fitness Machine Service)
* **Control Characteristic:** `0x2AD9` (Machine Control Point)
* **Live Telemetry Stream:** `0x2ACD` (Treadmill Data)

## Getting Started

### Prerequisites

* A walking pad or treadmill supporting standard BLE FTMS.
* A browser with Web Bluetooth enabled (e.g., Google Chrome, Microsoft Edge, Opera, or Bluefy on iOS).
* A secure origin host context (`https://`) or local environment context (`localhost`), as required by Web Bluetooth security architectures.

### Installation & Deployment

Since the interface is entirely self-contained inside a single file, setup is minimal:

1. Clone this repository or download `walkpadspeed.html`.
2. Deploy the file to your web server (e.g., Apache, Nginx, or GitHub Pages).
3. Access the file using your browser over an `https://` connection.

## License

© Colas Nahaboo, 2026. MIT license, that means that you can do anything with it, but expect no warranty.
