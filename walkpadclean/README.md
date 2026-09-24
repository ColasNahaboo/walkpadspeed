# walkpadclean

A tiny, standalone single-file web app for cleaning and oiling a **Bluetooth walking pad** belt.

It is **not** part of `walkpadspeed.html` — it's a separate tool for a single job: keep the belt spinning for a fixed amount of time so you can oil it, then stop the pad automatically. That frees both hands (which are covered in oil) to finish the job instead of holding a button down.

## What it does

1. Connect to your walkpad over Bluetooth (Web Bluetooth, FTMS protocol).
2. Show 5 buttons: **30s · 45s · 1mn · 1mn30s · 2mn**.
3. Tap a button. The app waits until the belt is actually spinning (speed > 0.1 km/h).
4. It counts down the chosen duration in seconds, with a progress bar.
5. When the countdown ends, it **stops the pad** and plays a beep, then returns to the button panel — ready for another round.

## How to use it

1. Open `walkpadclean.html` in **Google Chrome** on your phone or tablet (must be served over **HTTPS** — see below).
2. Tap **Connect to walkpad** and pick your walkpad from the Bluetooth picker.
3. Start the belt using the **physical remote** that came with the pad.
4. Tap the duration you want (e.g. **2mn**). The countdown begins once the belt is spinning.
5. While it counts down, oil the belt along its full travel.
6. When it reaches 0, the pad stops and beeps. The belt is clean and oiled.

> The app never sends a start or speed command — it only waits, counts, and stops. You control belt speed with the pad's own remote.

## Requirements

- **Google Chrome** (Web Bluetooth is not supported in Safari or Firefox).
- The walkpad must support the standard **FTMS** (Fitness Machine) Bluetooth protocol. Most walking pads sold with a companion phone app use it.
- **HTTPS** (or `http://localhost`). Web Bluetooth does **not** work from `file://`.

### Serving the file

Because Web Bluetooth requires a secure context, you can't just open the file directly. Options:

- Host it on a static HTTPS site (e.g. GitHub Pages, Netlify, or your own server).
- The ready-to-use hosted copy lives at:
  <https://colasnahaboo.github.io/walkpadspeed/walkpadclean/walkpadclean.html>
- For local testing, serve it over HTTPS or `localhost`:

  ```bash
  # from the walkpadclean/ directory
  python3 -m http.server 8000
  # then open http://localhost:8000/walkpadclean.html on the same machine
  ```

  For a phone, serve over HTTPS (e.g. with a TLS-terminating proxy) or use a tool like `localhost` tunneling.

## Files

- `walkpadclean.html` — the entire app (HTML + CSS + JS in one file, no dependencies).

## Notes

- A **wake lock** keeps the screen on during a countdown.
- If the belt stops mid-countdown (you pause it manually), the app aborts and returns to the panel.
- **Cancel** is available during both the "waiting for belt to spin" phase and the countdown.
- After stopping, the app stays connected, so you can immediately run another cleaning cycle.

## How it works (protocol)

`walkpadclean.html` uses the same FTMS BLE protocol as [`walkpadspeed.html`](https://github.com/ColasNahaboo/walkpadspeed):

- Connects to the **Fitness Machine Service** (`0x1826`).
- Reads speed from the **Fitness Machine Data** characteristic (`0x2ACD`) — flags byte + uint16 LE speed at 0.01 km/h resolution.
- Stops the pad by sending a **speed-0 command** (opcode `0x02`, speed `0`) followed by a **pause** command (opcode `0x08`).

It sends no start or speed commands — the belt is driven entirely by the pad's physical remote.

## License

Same as `walkpadspeed.html` — see the parent repository.
