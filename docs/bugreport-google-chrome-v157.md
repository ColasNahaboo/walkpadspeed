# Web Bluetooth: `startNotifications()` never resolves — NPE in `BluetoothGattCharacteristicWrapper` dispatch when a device sends notifications on characteristics the page has not accessed

**Component:** Blink > Bluetooth
**Type:** Bug (regression)
**Version:** Chrome 157.0.0.0 (Android, Play Store, auto-updated 2026-11-11)
**Regressed between:** Chrome ≤156 (worked for months, same device + same page) and 157.0.0.0
**Severity suggestion:** Sev-2 — Web Bluetooth heart-rate band subscription is broken for this class of devices; no web-side workaround exists.

---

## Summary

On Chrome 157 for Android, `BluetoothCharacteristic.startNotifications()` never
resolves (neither fulfils nor rejects) for a COROS heart-rate chest strap. The
BLE link is healthy: the device connects, service discovery completes, Android
reports `setCharacteristicNotification()` was called, and HR notifications
arrive at the Java layer at 1 Hz — but the `onDescriptorWrite` callback is
never delivered to Chrome, so the JS promise hangs forever.

Concurrently, `logcat` shows a `NullPointerException` **on every notification**
(1 Hz, the device's notification rate) inside Chrome's obfuscated
`org.chromium.device.bluetooth` wrapper code. The NPE kills the dispatch of
that notification: the page's `characteristicvaluechanged` JS event never
fires for the subscribed `heart_rate_measurement` characteristic either, and
the `onDescriptorWrite` completion for the CCCD write is never delivered — so
`startNotifications()` hangs forever even though the notifications are
arriving at the Android callback layer.

```
W/Binder: java.lang.NullPointerException: Attempt to read from field
  'android.bluetooth.BluetoothGattCharacteristic
   org.chromium.device.bluetooth.wrapper.BluetoothGattCharacteristicWrapper.a'
  on a null object reference in method
  'void o03.onCharacteristicChanged(android.bluetooth.BluetoothGatt,
   android.bluetooth.BluetoothGattCharacteristic)'
    at android.bluetooth.BluetoothGattCallback.onCharacteristicChanged(BluetoothGattCallback.java:160)
    at android.bluetooth.BluetoothGatt$GattCallback.lambda$onNotify$0(BluetoothGatt.java:558)
    ...
```

The device periodically sends notifications on **vendor-service
characteristics the page never accessed** (so Chrome's per-device wrapper map
has no entry for them). The resulting NPE in the `onNotify` binder callback
appears to abort processing of the device's callback queue, which also swallows
the `onDescriptorWrite` completion for the CCCD write that
`startNotifications()` is waiting on.

The same device works with:

- **BlueZ** on Linux (`bluetoothctl`: CCCD write completes, notifications
  stream at 1 Hz) — the device itself is fine.
- **nRF Connect** on the same phone.
- **Vivaldi** (older bundled Chromium) on the same phone — succeeds after a
  few retries, which points at a race in the new dispatch path.
- **Chrome itself before the 2026-11-11 auto-update** — the same web app
  connected this band reliably for months.

Edge (Chromium 157-era) reproduces the hang.

## Environment

- Phone: Pixel (adb serial `37251FDJG000DP`), Android, Chrome for Android
  157.0.0.0 (UA: `Mozilla/5.0 (Linux; Android 10; K) ... Chrome/157.0.0.0 Mobile Safari/537.36`)
- Device under test: **COROS HEART RATE 7BD111** chest strap,
  public static address `D1:F9:A6:A2:FC:6D`
- Web page: self-hosted single-file app (walkpadspeed,
  https://walkpad.fr) + a standalone diagnostic
  (https://walkpad.fr/hrmdiag.html) that shares no code with the app
- No bond/pairing: the device is not in Android's saved devices; no companion
  app installed; verified no other central holds the link (BlueZ on a Linux
  host in the same room connects it fine while the phone fails).

## Device behaviour (why it triggers this)

The strap is a standard Heart Rate service device (0x180D / 0x2A37) but also:

1. **Pushes notifications at ~1 Hz on vendor characteristics** without any
   subscription, from these services (seen in its advertisement/discovery):
   - `6e400001-b5a3-f393-e0a9-77656c6f6f70`
   - `6e400001-b5a3-f393-e0a9-e50e24dcca9e`
   - `75f50001-e97c-43f9-9a1d-bd83438f6b99`
2. Rejects a CCCD write to its Service Changed descriptor (handle `0x0013`)
   with `Error: Attribute Not Found (0x0a)` (captured with `btmon` from a
   BlueZ central).
3. Does not answer CCCD **reads** (they time out) — CCCD writes work.

None of this is fatal for BlueZ or nRF Connect, which route notifications by
handle and ignore unknown ones.

## Steps to reproduce

1. Open https://walkpad.fr/hrmdiag.html in Chrome 157 on Android
   (or use the minimal snippet below).
2. Tap **Connect**, pick `COROS HEART RATE 7BD111`.
3. Observe the diagnostic log.

Minimal reproduction (no dependencies):

```js
const device = await navigator.bluetooth.requestDevice({
  filters: [{ services: ['heart_rate'] }],
});
const server = await device.gatt.connect();
const service = await server.getPrimaryService('heart_rate');
const char = await service.getCharacteristic('heart_rate_measurement');
char.addEventListener('characteristicvaluechanged', e => console.log(e));
await char.startNotifications();   // ← never resolves, never rejects
console.log('unreachable');
```

### Observed (Chrome 157)

Clean reproduction captured 2026-11-15 08:32 (logcat buffer cleared beforehand,
band freshly released from the Linux host, single tab, no other BLE device
connecting at that moment) — see `logcat-chrome157-hrm-fail-filtered.txt`:

```
08:32:08.958  cr_Bluetooth: connectGatt
08:32:08.974  BluetoothGatt: onConnectionState() - status=0 connected=true device=XX:XX:XX:XX:FC:6D
08:32:08.975  BluetoothGatt: onConfigureMTU(XX:XX:XX:XX:FC:6D, 517, 0)
08:32:08.999  BluetoothGatt: onSearchComplete(XX:XX:XX:XX:FC:6D, _, 0)
08:32:09.021  BluetoothGatt: setCharacteristicNotification() - uuid: 00002a37-... enable: true
08:32:09.320  cr_Bluetooth: wrapper onCharacteristicChanged.   (first notification)
08:32:09.322  W/Binder: NullPointerException ... BluetoothGattCharacteristicWrapper.a  (2 ms later)
              ... notifications continue at 1 Hz, NPE repeats, ×63 changed / ×21 NPE over ~20 s ...
              onDescriptorWrite: 0 occurrences — never delivered
```

Diagnostic output (all steps before the subscription are healthy):

```
+  2.65s device: COROS HEART RATE 7BD111
+  2.82s gatt.connect OK (connected=true)
+  4.16s wrapper warm-up OK          (getPrimaryServices() + getCharacteristics()
                                      on all 6 services, 17 characteristics)
+  4.17s characteristic OK (notify=true indicate=false read=false)
+  4.17s startNotifications() …
+ 14.17s FAILED: startNotifications timed out after 10s
```

Same signature in an earlier Chrome session (2026-11-15 00:04, buffer not
cleared — kept for reference):

```
00:04:05.539 onConnectionState() - status=0 connected=true device=XX:XX:XX:XX:FC:6D
00:04:05.552 onConfigureMTU(XX:XX:XX:XX:FC:6D, 517, 0)
00:04:06.842 onSearchComplete(XX:XX:XX:XX:FC:6D, _, 0)
00:04:06.898 setCharacteristicNotification() - uuid: 00002a37-... enable: true
00:04:07.426 wrapper onCharacteristicChanged.
00:04:07.426 device onCharacteristicChanged.
00:04:07.428 W/Binder: java.lang.NullPointerException: ... BluetoothGattCharacteristicWrapper.a
                       on a null object reference in method 'void o03.onCharacteristicChanged(...)'
00:04:08.446 wrapper onCharacteristicChanged.
00:04:08.448 W/Binder: java.lang.NullPointerException: ... (same)
   ... repeats at 1 Hz indefinitely ...
   (no "onDescriptorWrite" line ever appears)
```

For comparison, in the same session the same page subscribes to an FTMS
treadmill (FS-9C3638) and gets
`onDescriptorWrite status:0==OK` within 150 ms — the CCCD callback path works
for well-behaved devices.

### Expected

`startNotifications()` fulfils (the CCCD write completes — Android's
`onDescriptorWrite` fires, as it does on BlueZ, nRF Connect, and Chrome ≤156),
and `characteristicvaluechanged` fires for `heart_rate_measurement`.
Notifications arriving on characteristics the page has not accessed must be
dropped silently, not thrown into the callback queue as an uncaught NPE.

## Additional observations

1. **The NPE is thrown inside the `IBluetoothGattCallback` binder transaction**
   (`W/Binder` tag). It repeats at exactly the device's notification rate,
   i.e. once per unsolicited vendor notification. The `onDescriptorWrite`
   callback for the *same device* is never delivered afterwards, which is
   consistent with the exception aborting the per-device callback dispatch.

2. **Race behaviour:** Vivaldi (older Chromium) succeeds after a few retries
   on the same phone and device — consistent with a timing window between the
   first unsolicited notification and the wrapper registration for the
   subscribed characteristic.

3. **Not a page-side bug:** we tried (a) declaring the vendor services in
   `optionalServices`, (b) eagerly enumerating every service and
   characteristic (`getPrimaryServices()` → `getCharacteristics()`) before
   subscribing, so wrappers exist for all characteristics — the NPE and the
   hang persist unchanged. (c) Racing `startNotifications()` against the first
   `characteristicvaluechanged` event also never resolves, because the JS-level
   event never fires either (the notification dies in the Java layer before
   reaching the page). The diagnostic's own log (`hrmdiag-chrome157-fail.log`)
   shows the warm-up succeeding and the subscription still hanging.

4. **Secondary finding (possibly separate bug):** after toggling the phone's
   Bluetooth off/on from Quick Settings, every subsequent Chrome GATT
   operation fails with

   ```
   E/BluetoothGatt: android.os.DeadObjectException
       at android.bluetooth.BluetoothGatt.disconnect(BluetoothGatt.java:1097)
       at org.chromium.device.bluetooth.ChromeBluetoothDevice.disconnectGatt(...)
   ```

   i.e. Chrome's `BluetoothAdapter`/`BluetoothGatt` remains bound to the
   previous (dead) Bluetooth-stack binder; `chrome://bluetooth-internals`
   shows the device stuck "Connected" and its Disconnect/Forget buttons do
   nothing. Only `adb shell am force-stop com.android.chrome` recovers
   (Android Settings → Force stop did not). Chrome should detect the stack
   restart and rebind.

## Suggested fix

In the Java wrapper's `onCharacteristicChanged` (the `o03` callback class in
the obfuscated build), look up the characteristic wrapper defensively: if the
incoming `BluetoothGattCharacteristic` has no registered wrapper, log and drop
the notification instead of dereferencing `null`. This restores the pre-157
behaviour for quirky-but-common devices (vendor notifications on
undiscovered/unaccessed characteristics) and unblocks the CCCD callback.

## Attachments

- `logcat-chrome157-hrm-fail-filtered.txt` — clean reproduction (buffer
  cleared, single device): connect → discovery → `setCharacteristicNotification`
  → notifications at 1 Hz → NPE 2 ms after the first one → `onDescriptorWrite`
  never delivered.
- `logcat-chrome157-hrm-fail-full.txt` — the same session, unfiltered.
- `btmon-bluez-hrm-subscribe-ok.pcap` (+ `.txt` rendering) — the same band
  subscribed successfully from a BlueZ central on the same network: CCCD write
  to handle `0x0023` (`0100`) accepted, `Handle Value Notification` at 1 Hz,
  clean disable (`0000`) on disconnect. Proves the device and link are fine.
- `hrmdiag-chrome157-fail.log` — the standalone diagnostic's own output for
  the failing attempt (warm-up OK, subscription hangs).
- Reproduction page: https://walkpad.fr/hrmdiag.html (open-source,
  https://github.com/ColasNahaboo/walkpadspeed/blob/main/hrmdiag.html)
