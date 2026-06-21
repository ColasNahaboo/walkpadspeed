# walkpadspeed
<img src="docs/walkpadspeed.svg" align="right" width="256" height="256">A simple HTML page to program the speed intervals of walking pad workouts over the standard  FTMS Bluetooth protocol.

I bought a simple, entry level walking pad, because I wanted something less bulky than a treadmill, easy to install and store away, and I favored mechanical qualities over exotic features. And thus on such simple pads, the speed is the only thing that apps can remote control (no automatic incline setting...), and there are no sensors (heart rate...). Buit they all implement a subset of the standard [FTMS (Fitness Machine Service) Bluetooth protocol](https://www.bluetooth.com/specifications/specs/fitness-machine-service-1-0/).

I wanted however an app where it was easy to program various routines, as it was my first pad, and I wanted to expereiment a lot with the possible routines. I discovered that apps either required expensive subscriptions, or were super complex to program. or had bugs because they tried to cater to very complex treadmills of to provide full health tracking plans. 

[MyHomeFit](https://myhomefit.de/) was the closest I could find to satisfy my needs, but writing programs in their XML format or buil-in editor was horrible, and it could not manage simply setting a speed, as speeds drifted because it was relying on data from the device and trying to perform complex computations and cumultaed rounding errors in the process.

## Features

So I designed walkpadspeed to ["scratch my own itch"](https://dev.to/lirena00/scratch-your-own-itch-how-to-build-and-ship-50a9) and create an app that would be useful for me, and I think all the people like me wanting freedom to control simply their simple walking pads. An application that would be:

- **setting speeds** only.
- **easy to program** routines as series of "steps", where the pad runs at some speed for some time.
- **easy to manage** these programs, by having them is a simple terse text form, to edit easily in any editor, and not some XML abomination.
- **easy to install** as it consists of only a single HTML file (embedding CSS and modern vanilla javascript code) that you just open in your phone browser (if supported, see Requirements below) or any computer with bluetooth capabilities.
- **easy to use** simple controls implementing my needs simply.
- **opiniotated** keep bloat away by refusing to add non-essential features that could be found in other, more complex apps.

**Requirements** The browser on your phone must support [Web Bluetooth](https://github.com/WebBluetoothCG/web-bluetooth#web-bluetooth). Currently: Google Chrome, Samsung Internet, Opera, Opera Mobile, Microsoft Edge, Vivaldi, Brave, Bluefy, BLE Link, WebBLE... but currently **not Firefox** (although some [extensions](https://addons.mozilla.org/en-US/firefox/addon/webbt/) exist). See the [current state of Web Bluetooth browser support](https://github.com/WebBluetoothCG/web-bluetooth/blob/main/implementation-status.md).

## Implementation

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
