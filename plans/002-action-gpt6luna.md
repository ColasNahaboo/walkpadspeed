# Plan 002: Consume LAN heart-rate snapshots in walkpadspeed

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. Stop at any condition in "STOP conditions"; do not improvise.
> When complete, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 0ed72f1..HEAD -- walkpadspeed.html test README.md`.
> Also check the backend repository:
> `git -C ../hr-relay diff --stat 4402df5..HEAD -- main.go README.md main_test.go`.
> If either repository changed, compare the excerpts below with live code.
> Do not begin app integration unless plan 001's Android reachability gate passed.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/001-hr-relay-lan-api.md`
- **Category**: direction
- **Planned at**: `walkpadspeed` commit `0ed72f1`, 2026-11-20; `hr-relay`
  commit `4402df5`

## Why this matters

Walkpadspeed currently receives HR only through Web Bluetooth. On 2026-11-19,
the relay's COROS feed remained active, but the phone-side BLE client disconnected
about 39 seconds after connecting. A LAN client would keep COROS connected to
the relay and replace only the phone's BLE hop with small HTTP reads. This gives
the app a second transport without changing HR zones, logging, or the working
BLE path.

## Current state

- `walkpadspeed.html:2069-2131` implements `connectHRM()`: it opens the Web
  Bluetooth picker, runs `openHrmGatt()`, and installs a
  `characteristicvaluechanged` handler. `HRM_CONNECT_BUDGET_MS` is currently
  40 seconds.
- `walkpadspeed.html:2224-2241` decodes the standard Heart Rate Measurement
  bytes, updates `currentHeartRate` and `hrHistory`, and calls `updateHrmUI()`
  and `updateHrZone()`. The LAN path should converge on this same processing
  pipeline, not duplicate zone/session logic.
- `walkpadspeed.html:718-756` is the Connections view. It has a BLE HR button
  (`#connectHrmBtn`), HR status (`#connHrmStatus`), a shared status line, and a
  debug panel. Keep the BLE button and behavior available.
- `hrmCharacteristic` currently represents both a BLE characteristic and
  “HR source available”; Test Mode even sets it to `true`. Other code uses it
  as a guard for zone control, zone-terminated steps, session logging, and
  connection UI. Do not store a fake characteristic for the LAN transport;
  introduce a clear transport/fresh-data state and update the non-BLE guards.
- The app is a single self-contained HTML file with no build system. Tests use
  Playwright and are run by `test/RUN-ALL-TESTS`; `test/check-types.cjs` checks
  the inline script against a baseline of 36 existing TypeScript errors.
- Existing test examples: `test/routines.test.cjs` for browser-server setup and
  `test/nav.test.cjs` for real-page UI assertions.

Current-state excerpt from `walkpadspeed.html:2093-2115`:

```js
hrmDevice = await navigator.bluetooth.requestDevice({
    filters: [{ services: ['heart_rate'] }],
    optionalServices: [/* standard and COROS vendor services */]
});
const characteristic = await openHrmGatt();
characteristic.addEventListener('characteristicvaluechanged', handleHrmNotification);
hrmCharacteristic = characteristic;
```

The current notification handler at `walkpadspeed.html:2224-2241` decodes BPM,
updates `currentHeartRate`/`hrHistory`, then calls the UI and zone pipeline.
The current `hrmConnected()` at `walkpadspeed.html:4813-4814` is
`return !!hrmCharacteristic;`.

## Commands you will need

Run from the `walkpadspeed` repository:

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Full suite | `test/RUN-ALL-TESTS` | `ALL TESTS PASSED`; type error count does not exceed 36 |
| Inline JS syntax | See command below | `node --check` exits 0 |
| Backend API | `cd ../hr-relay && go test ./...` | All relay API tests pass |

Inline JavaScript syntax check after edits:

```bash
node -e 'const fs=require("fs"); const h=fs.readFileSync("walkpadspeed.html","utf8"); const m=h.match(/<script>([\s\S]*)<\/script>\s*<\/body>/); if(!m) process.exit(1); fs.writeFileSync("/tmp/walkpadspeed-inline.js",m[1])' \
  && node --check /tmp/walkpadspeed-inline.js \
  && rm /tmp/walkpadspeed-inline.js
```

## Suggested executor toolkit

- Invoke `modern-web-guidance` for browser fetch, local-network access, and
  security guidance before editing client-side network code.
- Use the Android browser and LAN endpoint from plan 001 for the manual
  compatibility check; Playwright cannot reproduce Chrome Android's permission
  prompt.

## Scope

**In scope**:

- `walkpadspeed.html`
- `test/hrm-lan.test.cjs` (new)
- `README.md`

**Out of scope**:

- `../hr-relay` source (handled by plan 001).
- The COROS BLE protocol, relay BLE roles, HR zone calculations, treadmill
  control, and session-log format.
- Raw TCP/UDP, WebTransport, WebRTC, a public tunnel, or disabling browser
  security.
- Any private server URL in user-visible text or documentation.

## Git workflow

- Keep walkpadspeed changes in this repository and separate from the
  `hr-relay` commit.
- Before committing code, follow this repository's `AGENTS.md`: increment the
  CSS build version from `v1.2.0-dev.6` to `v1.2.0-dev.7` (or increment the
  current dev suffix if the version has moved), load `auto-commit`, stage the
  intended changes, and use a lowercase Conventional Commit such as
  `feat: read heart rate over LAN`. Do not push unless instructed.

## Steps

### Step 1: Reconfirm browser reachability before adding UI

Use the exact HTTPS origin where the phone runs walkpadspeed and the configured
LAN endpoint from plan 001. Verify an authorized request succeeds in Android
Chrome and that the response has the expected CORS headers. If the browser
blocks the request or the user denies Local Network Access, stop; do not
silently fall back to insecure content, wildcard CORS, or a different port.

**Verify**: Android Chrome receives HTTP 200 and valid JSON from the LAN API
while the relay has a fresh sensor sample. If not, mark this plan BLOCKED and
report the exact browser error before writing app code.

### Step 2: Add an explicit Wi-Fi HR connection control

On the Connections view, add a separate LAN HR endpoint field and
“Connect over Wi-Fi” / disconnect affordance. Do not repurpose
`#connectHrmBtn`; users must still be able to choose the existing BLE HRM path.
Persist the endpoint URL locally. Treat the bearer token as a password: do not
show it in status/debug text or persist it by default (session-only storage is
acceptable). Explain that the phone and relay must be on the same reachable
LAN and that the browser may ask for local-network permission.

**Verify**: manual UI check shows separate BLE and Wi-Fi choices, and the
existing BLE Connect button still opens the Bluetooth chooser.

### Step 3: Share one BPM processing path between transports

Extract the BPM update logic from `handleHrmNotification(event)` into a helper
that accepts a validated integer BPM and sample time/sequence. The existing BLE
handler should keep decoding the Heart Rate Measurement flags/uint8/uint16
value, then call the helper. The LAN poller must call the same helper only for
a new `sampleSeq`; do not append duplicate HR history samples on every poll of
an unchanged relay response.

Introduce an explicit HR transport state (for example `null`, `ble`, `lan`, or
`test`) and a freshness predicate. Replace only the non-transport-specific
`hrmCharacteristic` truthiness checks used by `hrmConnected()`, zone-targeted
steps, zone-terminated steps, HR zone control, resume/step navigation, and
session logging. Keep direct `hrmCharacteristic` access where actual BLE
operations or BLE disconnects require the characteristic object.

**Verify**: with a deterministic mocked HR sample, the shared helper updates
the BPM display, zones, and history once; the existing BLE and Test Mode paths
retain their previous behavior.

### Step 4: Implement bounded HTTP polling and safe stale handling

Poll `GET /api/v1/hr` approximately once per second with `fetch`, the configured
bearer token, and no overlapping requests. Use a recursive `setTimeout` or an
equivalent serialized loop; cancel it with an `AbortController` on disconnect.
Validate the response shape; accept only positive safe-integer BPM and
non-negative safe-integer `sampleSeq` / `sampleAgeMs`. Reject malformed JSON,
non-200 responses, and duplicate `sampleSeq` values.

Treat `sensorConnected === false`, a null BPM, or `sampleAgeMs > 5000` as stale.
Show an explicit stale/disconnected status, clear the active BPM used by
zone-control and session logging, and never keep adjusting treadmill speed
from an old sample. Recover automatically when a fresh sequence arrives.
Network errors must not increment `hrmFailCount` or trigger the BLE
“reload-the-tab” path. Ensure disconnect, Test Mode switching, and page
navigation stop/clean up the poller.

**Verify**: fake fresh, stale, and failed responses in the browser test; fresh
data updates HR, stale data clears it within 5 seconds, and disconnect prevents
further requests or state updates.

### Step 5: Document setup and run the full verification

Update the README HR-monitoring section with LAN setup using placeholders,
token handling, Android local-network permission, stale-data behavior, and
troubleshooting. Never include a real private host/domain, token, or secret.
Add `test/hrm-lan.test.cjs` following the existing Playwright test style.

Run `test/RUN-ALL-TESTS`, the inline `node --check` command above, and
`go test ./...` from `../hr-relay`.

**Verify**: all commands exit 0; `test/RUN-ALL-TESTS` prints
`ALL TESTS PASSED`; the inline type-check count remains at or below 36.

### Step 6: Validate end to end on the phone

With the relay connected to COROS and the phone on the same LAN, connect via
Wi-Fi and verify BPM, zone color/label, and HR-based routine control. Then
stop or cover the strap and confirm the app marks data stale and does not use
the last BPM for control. Restore the sensor feed and confirm recovery. Also
verify BLE HR remains selectable and disconnecting one transport does not leave
the other marked connected.

**Verify**: complete one short test routine without a Bluetooth device picker
for HR; record fresh/stale/recovery results and confirm the app debug log never
contains the bearer token.

## Test plan

- Add `test/hrm-lan.test.cjs` using the existing static-server/Playwright style.
- Cover: LAN connect success; valid response updates BPM/zone/history; same
  `sampleSeq` is processed once; stale/null/offline response clears HR; HTTP
  and JSON errors are visible and recoverable; disconnect stops polling;
  switching to Test Mode cleans up LAN polling; LAN mode does not call
  `navigator.bluetooth.requestDevice`; the existing BLE mode remains available.
- Run `test/RUN-ALL-TESTS` and the inline syntax check after the version bump.
- The Android Chrome end-to-end test is mandatory; the browser's local-network
  permission and secure-origin behavior cannot be verified by headless tests.

## Done criteria

- [ ] Users can deliberately select Wi-Fi HR without changing the existing BLE
  HR flow.
- [ ] Fresh relay samples use the existing BPM/zone/history pipeline exactly
  once per `sampleSeq`.
- [ ] Stale or failed samples cannot drive zone control or be logged as fresh.
- [ ] Disconnect and Test Mode changes reliably stop HTTP polling.
- [ ] Endpoint/token are absent from debug and status text; no private URL is
  added to README or code comments.
- [ ] `test/RUN-ALL-TESTS`, inline `node --check`, and `go test ./...` exit 0.
- [ ] Android Chrome end-to-end test confirms fresh HR, stale detection, and
  recovery over the LAN.
- [ ] Only the in-scope files changed and the plan status row is updated.

## STOP conditions

- Plan 001's Android reachability gate has not passed.
- The secure app origin cannot reach the endpoint without weakening browser
  protections or exposing a wildcard/public service.
- The live API shape differs from plan 001; stop and reconcile the plans before
  changing either side.
- Supporting LAN HR would require changing HR zone algorithms, session-log
  schema, treadmill behavior, or the direct COROS BLE protocol.
- Any regression appears in BLE HR or Test Mode after two focused attempts to
  diagnose it; stop and report rather than broadening the refactor.

## Maintenance notes

- `sampleSeq` is the idempotency key for 1 Hz polling; do not substitute BPM
  equality because valid sensor packets often repeat the same BPM.
- Keep stale-data handling separate from transport connectivity: the relay
  endpoint may be reachable while its upstream sensor is asleep.
- Review mobile browser network permissions and exact CORS origin whenever the
  app's deployment origin changes.
- Revisit SSE only if measured polling overhead or update latency is a problem.
