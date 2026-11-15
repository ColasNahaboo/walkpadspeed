# COROS HEART RATE (HR31) — BLE firmware non-conformance breaks Web Bluetooth / Android BLE clients

**Reported by:** Colas Nahaboo — <https://github.com/ColasNahaboo>
**Date:** 2026-11-15
**Device:** COROS HEART RATE chest strap (COROS HR31)
**Severity:** High — the device is unusable with any web app (Web Bluetooth) and
with Android BLE clients that follow the standard subscription flow, while it
works with others. This is a device firmware defect, not a client bug.

---

## 1. Device identification (read live over BLE, Device Information service 0x180A)

| Characteristic | Value |
|---|---|
| Manufacturer Name (0x2A29) | `gysys` |
| Model Number (0x2A23) | `01 02 03 04 05 5f 00 00` (raw, not a printable string) |
| Serial Number (0x2A24) | `COROS HR31` |
| Hardware Revision (0x2A25) | `2991F1404180` |
| Firmware Revision (0x2A26) | `VXYZaj` (placeholder — not a real version string) |
| Firmware String (0x2A27) | `V42` |
| Hardware String (0x2A28) | `V 1.26.0` |
| Certificate (0x2A2A) | `00 00 00 00 00 00` (empty) |
| Advertised name | `COROS HEART RATE 7BD111` |
| Public static address | `D1:F9:A6:A2:FC:6D` |

The `gysys` manufacturer string and the placeholder values (`VXYZaj`, raw-byte
Model Number) indicate a generic OEM heart-rate module. The firmware defect described
below is exactly the kind of defect such modules ship with.

## 2. GATT table as exposed by the device

Primary services discovered on connect:

| Service | UUID | Notes |
|---|---|---|
| 0x1800 Generic Access | standard | |
| 0x1801 Generic Attribute | standard | |
| 0x180A Device Information | standard | |
| 0x180D Heart Rate | standard | `0x2A37` Heart Rate Measurement, flags = `notify` |
| 0x180F Battery Service | standard | |
| `6e400001-b5a3-f393-e0a9-77656c6f6f70` | **vendor** | Nordic UART–style; `0x…0003` char = `notify`, `0x…0002` = write |
| `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | **Nordic UART Service (NUS)** | `0x6e400003-…` = `notify`, write char present |
| `75f50001-e97c-43f9-9a1d-bd83438f6b99` | **vendor** | proprietary telemetry |

The strap exposes **three non-standard services with `notify` characteristics**
in addition to the standard Heart Rate service.

## 3. The defect

**The strap transmits BLE notifications on its vendor-service characteristics
unsolicited, at ~1 Hz, continuously, from the moment a central connects —
without the central ever having written to those characteristics' CCCD
descriptors.**

In other words, the device pushes notification packets on handles the client
has not subscribed to. This violates the Bluetooth Core Specification ATT
behaviour: a peripheral must only send `Handle Value Notification` for a
characteristic whose Client Characteristic Configuration Descriptor the client
has explicitly enabled.

### Why this breaks standard clients

A conformant client (Android's `BluetoothGatt` / Chrome's Web Bluetooth, iOS,
BlueZ's strict path, etc.) keeps a per-connection table of known
characteristic handles. When an unsolicited notification arrives on a handle
that is not in the table, the client cannot map it to any characteristic.

- **Android / Chrome:** the notification is delivered to
  `BluetoothGattCallback.onCharacteristicChanged()` with a `null`
  characteristic wrapper. This throws a `NullPointerException` **once per
  notification, at 1 Hz**, on the callback thread. The flood of exceptions
  stalls the GATT callback dispatch, so the *legitimate* CCCD write
  acknowledgement for the Heart Rate characteristic (`onDescriptorWrite`) is
  never processed. The client's `startNotifications()` promise therefore never
  resolves, and the heart-rate stream can never be subscribed.
- **BlueZ on Linux** routes notifications by handle and silently ignores the
  unknown ones, so the same strap works perfectly there — which is what makes
  this look like a "browser bug" from the outside, when it is not.

## 4. Evidence

### 4.1 Unsolicited vendor notifications → Android GATT callback crash (1 Hz)

From `logcat` on a Pixel (Android 15, Chrome 157) while the strap is connected
and the app is trying to subscribe to Heart Rate Measurement (`0x2A37`). One
exception per second, matching the strap's notification cadence:

```
W/Binder: java.lang.NullPointerException: Attempt to read from field
  'android.bluetooth.BluetoothGattCharacteristic
   org.chromium.device.bluetooth.wrapper.BluetoothGattCharacteristicWrapper.a'
  on a null object reference in method
  'void o03.onCharacteristicChanged(android.bluetooth.BluetoothGatt,
       android.bluetooth.BluetoothGattCharacteristic)'
    at android.bluetooth.BluetoothGattCallback.onCharacteristicChanged(BluetoothGattCallback.java:160)
    at android.bluetooth.BluetoothGatt$GattCallback.onNotify(BluetoothGatt.java:553)
    at android.bluetooth.IBluetoothGattCallback$Stub.onTransact(IBluetoothGattCallback.java:245)
```

155 such exceptions were captured in a single ~3-minute log window
(`logcat-chrome157-hrm-fail-filtered.txt`). They begin the instant the
connection is established and continue at 1 Hz for the life of the link.

### 4.2 The Heart Rate CCCD write is never acknowledged

The client issues the standard subscription sequence:

```
D/BluetoothGatt: setCharacteristicNotification() - uuid: 00002a37-... enable: true
```

Android issues the CCCD write, but the corresponding
`onDescriptorWrite` callback **never fires** — it is starved by the
`onCharacteristicChanged` exception flood above. The web call
`startNotifications()` therefore hangs. From the app's own diagnostic
(`hrmdiag-chrome157-fail.log`):

```
+  2.82s gatt.connect OK (connected=true)
+  2.85s   75f50001-e97c-43f9-9a1d-bd83438f6b99: 2 chars
+  2.85s   6e400001-b5a3-f393-e0a9-e50e24dcca9e: 2 chars
+  2.85s   6e400001-b5a3-f393-e0a9-77656c6f6f70: 2 chars
+  2.86s   0000180d-0000-1000-8000-00805f9b34fb: 3 chars
+  2.86s characteristic OK (notify=true indicate=false read=false)
+  2.86s startNotifications() …
+ 12.87s FAILED: Error: startNotifications timed out after 10s
```

The three vendor services are visible in the enumeration; the standard Heart
Rate characteristic is found and reports `notify=true`; then the subscription
hangs.

### 4.3 The same strap works perfectly over a stack that ignores the bad packets

A raw HCI capture (`btmon-bluez-hrm-subscribe-ok.pcap`) of the **same strap**
on Linux/BlueZ shows a textbook-clean subscription: the client writes
`0100` to the Heart Rate CCCD (handle `0x0023`), the strap responds, and then
streams Heart Rate Measurements on handle `0x0022` at 1 Hz. BlueZ discards the
unsolicited vendor notifications by handle, so nothing wedges. This proves the
strap's *heart-rate* path is correct and that the failure is caused purely by
the extra, unsubscribed vendor traffic.

### 4.4 The failure is device-specific, not browser-specific

- Chrome 157, Edge, Vivaldi (all Chromium) on the same phone: **fail**
  (Vivaldi occasionally wins a race, unreliably).
- The same phone's nRF Connect app: works (it tolerates the noise).
- BlueZ on Linux: works.
- **A clean heart-rate peripheral that exposes only `0x2A37`: works in Chrome
  157 on the same phone, first try.** When the strap is bridged through a relay
  that re-exposes only the standard `0x2A37` characteristic, the very same
  Chrome build subscribes instantly (`onDescriptorWrite status:0`) and streams
  live heart rate. This isolates the cause to the strap's extra unsolicited
  notifications, not to any browser.

## 5. What COROS must fix (firmware)

1. **Stop sending notifications on characteristics the client has not
   subscribed to.** A device must not emit `Handle Value Notification` on any
   handle whose CCCD has not been written with the appropriate value by the
   connected central. This is the root cause and the only change strictly
   required.

2. **Gate the vendor telemetry services behind explicit subscription.** If the
   COROS app relies on the vendor services (`6e400001-…`, `75f50001-…`) for
   its own telemetry, those characteristics must:
   - advertise a proper CCCD descriptor, and
   - only notify after the central writes the CCCD to enable notifications.

   A central that only wants heart rate (a web app, a standard fitness client)
   must be able to subscribe to `0x2A37` and receive *only* heart-rate
   notifications, with no background traffic on other handles.

3. **Populate the Device Information service correctly.** The Model Number
   returns raw bytes `01 02 03 04 05 5f 00 00` instead of a printable string,
   and the PnP ID is all zeros. These should be valid UTF-8 strings / a valid
   PnP ID per the Assigned Numbers spec. (Minor, but it makes the device hard
   to identify in support logs.)

## 5b. Why this is a COROS bug and not a browser bug

A web app or Android app cannot opt out of notifications it never subscribed
to: the notification arrives at the OS BLE stack before any application code
runs, and the stack has no handle mapping for it. The only party that can stop
the traffic is the device firmware. Every other heart-rate product we tested
exposes only the standard characteristic (or properly CCCD-gated vendor ones)
and works flawlessly in the same browser. Chrome is simply the strictest
consumer of a contract the strap violates.

## 6. Reproduction (short)

1. Wear the COROS HR31 so it advertises and is not held by another device.
2. On an Android phone, open any Web Bluetooth heart-rate page (e.g.
   https://webbluetoothcg.github.io/web-bluetooth/demos/heartrate_monitor/ or
   https://github.com/ColasNahaboo/walkpadspeed) in Chrome.
3. Tap to connect and subscribe to the Heart Rate sensor.
4. **Expected:** heart rate appears. **Actual:** the subscription never
   completes; `startNotifications()` hangs / times out.
5. In parallel, `adb logcat` shows the 1 Hz `NullPointerException` in
   `BluetoothGattCallback.onCharacteristicChanged` from the moment of connect.
6. The same strap works with BlueZ on Linux and with nRF Connect on the same
   phone, confirming the device is the common factor.

## 7. Impact

- The product cannot be used with **any** web-based fitness application
  (Web Bluetooth), which is a large and growing class of apps.
- It fails with Android apps that use the standard
  `setCharacteristicNotification` + CCCD-write flow and do not defensively
  swallow unsolicited notifications.
- Users are told (wrongly) that their browser is broken, driving support load
  and negative reviews, when the device firmware is at fault.

## 7b. Workaround we had to build (for context)

To use the strap at all with our web app we wrote a BLE relay
(https://github.com/ColasNahaboo/hr-relay) that connects to the strap over
BlueZ, discards the vendor traffic, and re-advertises a single clean `0x2A37`
characteristic for the phone to connect to. This is a workaround for a device
defect, not a substitute for a firmware fix.

## 8. Attachments (in this repo's `docs/`)

- `logcat-chrome157-hrm-fail-full.txt` / `-filtered.txt` — Android logcat
  showing the 1 Hz NPE flood and the unacknowledged CCCD write.
- `hrmdiag-chrome157-fail.log` — Web Bluetooth diagnostic trace: connect OK,
  vendor services enumerated, `startNotifications()` times out.
- `btmon-bluez-hrm-subscribe-ok.pcap` / `.txt` — raw HCI capture of the same
  strap subscribing cleanly under BlueZ (heart-rate path is correct).

## 9. Contact

Colas Nahaboo — <https://github.com/ColasNahaboo>
Happy to provide additional captures, the raw HCI traces, or to test a firmware
build against this repro.
