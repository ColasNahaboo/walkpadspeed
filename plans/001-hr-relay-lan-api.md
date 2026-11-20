# Plan 001: Expose a protected LAN heart-rate snapshot API in hr-relay

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. Stop at any condition in "STOP conditions"; do not improvise.
> When complete, update this plan's row in `../walkpadspeed/plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 4402df5..HEAD -- main.go README.md main_test.go`
> from the `hr-relay` repository. Also check the coordinating app repository:
> `git -C ../walkpadspeed diff --stat 0ed72f1..HEAD -- walkpadspeed.html test README.md`.
> If relevant files changed, compare the excerpts below with live code before
> proceeding.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: direction
- **Planned at**: `hr-relay` commit `4402df5`, 2026-11-20; coordinating
  `walkpadspeed` commit `0ed72f1`

## Why this matters

The 2026-11-19 relay log shows the COROS-to-relay feed stayed active through the
workout, while the phone-side BLE client connected at 20:20:52 and disconnected
at 20:21:31. The relay's `HR … bpm` log lines are emitted while handling source
notifications; they do not prove that the phone received them. Moving only the
phone-to-relay hop to HTTP over the same LAN removes the unstable Web Bluetooth
link while keeping the working COROS-to-relay BLE connection.

## Current state

- `../hr-relay/main.go` is a small Go program using TinyGo Bluetooth:
  - Lines 68–95 hold the current BPM / last-sample state and forward each
    measurement to the BLE peripheral characteristic.
  - Lines 98–126 expose and advertise the BLE Heart Rate service.
  - Lines 236–298 register connection logging, advertise the peripheral, and
    repeatedly connect to and subscribe to the sensor.
- `../hr-relay/README.md:33-43` documents the current BLE → BLE topology.
- There is no HTTP server and no Go test file at the planned commit.
  `go test ./...` currently exits successfully with `[no test files]`.
- The relay's connection-state handler sees adapter connections generally.
  Do not treat every `client connected:` log line as a phone subscription.
  The HTTP API must report relay-owned source state directly.
- The walkpadspeed page is a single-file HTML app. The app is served from a
  secure origin for Web Bluetooth; a browser fetch from that page to a LAN
  HTTP origin may be subject to CORS, mixed-content, and Local Network Access
  controls. This must be verified on the actual Android browser before plan 002
  is implemented.

Current-state excerpt from `main.go:68-95`:

```go
type relay struct {
    mu       sync.Mutex
    hrm      *bluetooth.Characteristic
    lastBeat time.Time
    lastBPM  int
}

func (r *relay) onSensorData(data []byte) {
    // updates lastBeat/lastBPM, logs changed BPM, then calls r.hrm.Write(data)
}
```

## Commands you will need

Run from `../hr-relay`:

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Tests and compile check | `go test ./...` | Exit 0; `hr-relay` tests pass |
| Build check | `go build -o /tmp/hr-relay .` | Exit 0; temporary binary created outside the repository |

## Suggested executor toolkit

- Use the Go standard library (`net/http`, `encoding/json`, `net/http/httptest`);
  no new module dependency is needed.
- Before plan 002, verify current browser policy against
  [MDN Local Network Access](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Local_network_access)
  and [MDN CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS).

## Scope

**In scope** (paths relative to the `hr-relay` repository):

- `main.go`
- `main_test.go` (new)
- `README.md`

**Out of scope**:

- `go.mod` / `go.sum` — use only the standard library.
- `../walkpadspeed/walkpadspeed.html` and its tests — handled by plan 002.
- Systemd unit files, firewall rules, DNS, certificates, and files outside the
  `hr-relay` repository. Document the required operator configuration, but do
  not edit those machine-local files.
- Any BLE protocol, COROS parsing, relay advertising, or treadmill behavior.

## API and security contract

- Add an opt-in HTTP listener. The default must be disabled; enabling it
  requires an explicit listen address on the intended LAN interface.
- Expose one read-only endpoint: `GET /api/v1/hr`. Return JSON with this shape:

  ```json
  {
    "sensorConnected": true,
    "bpm": 104,
    "sampleSeq": 1234,
    "sampleAgeMs": 250
  }
  ```

  `sampleSeq` increments for every upstream HR measurement, even if BPM is
  unchanged. `bpm` and `sampleAgeMs` are `null` before the first sample.
  `sensorConnected` reflects the upstream BLE session; `sampleAgeMs` lets the
  client detect stale data independently of the relay's longer BLE reconnect
  timeout. Read and write this snapshot under the relay's existing mutex.
- Handle `OPTIONS` for browser preflight and `GET` only; do not add control,
  write, or arbitrary proxy endpoints.
- Require a non-empty bearer token from `HR_RELAY_HTTP_TOKEN` whenever the
  listener is enabled. Configure one exact allowed app origin. Set
  `Access-Control-Allow-Origin` only to that origin, add `Vary: Origin`, and
  allow only `GET`, `OPTIONS`, and the `Authorization` header. Never log or
  return the token. Do not use wildcard CORS or cookies.
- Refuse to start the HTTP listener if its required token/origin configuration
  is missing or invalid. Keep the endpoint opt-in and LAN-bound so a build
  that has not been configured does not expose health data.

## Git workflow

- Make and test this change in the separate `hr-relay` repository; do not mix
  its changes into the walkpadspeed repository.
- Use a conventional commit such as `feat: expose HR snapshots over LAN HTTP`
  if the operator asks for commits. Do not push or open a PR unless instructed.

## Steps

### Step 1: Add an immutable relay snapshot

Extend the relay state in `main.go` to track upstream connection state and a
monotonic `sampleSeq`. Update those fields alongside `lastBeat` and `lastBPM`
in the existing sensor-data path. Mark the source connected only while its
connection/forwarding session is active, and clear that state when the session
ends. Provide a snapshot method that copies all fields while holding the mutex;
the HTTP handler must not read mutable fields unsynchronized.

**Verify**: `go test ./...` → the existing package still compiles. Snapshot
assertions are added in step 3 and must pass before final acceptance.

### Step 2: Add the opt-in authenticated HTTP handler

Register `/api/v1/hr` using the standard library. Keep the handler and JSON
snapshot code small and independently testable. Validate method, exact Origin,
preflight headers, and bearer token. The listener must be started without
blocking the existing BLE scan/forward loop. If the operator explicitly
configured the listener and it cannot bind, log a clear startup error and fail
rather than silently advertising an API that is unavailable.

**Verify**: `go test ./...` → the handler compiles and the existing package
still passes. Full handler assertions are added in step 3.

### Step 3: Add Go tests and operator documentation

Add `main_test.go` with `httptest` coverage for:

- a fresh sample and the exact JSON fields;
- no sample yet (`bpm` / `sampleAgeMs` null);
- a stale sample and a disconnected upstream sensor;
- monotonically increasing `sampleSeq` when BPM repeats;
- missing/wrong token, wrong Origin, unsupported method, and valid `OPTIONS`;
- the disabled-by-default listener configuration.

Update `README.md` with the API shape, opt-in flags, token/origin configuration,
LAN binding/firewall requirements, a `curl` example using placeholders, and a
warning not to publish the listener to the internet. Do not put a real token or
private deployment URL in the README.

**Verify**: `go test ./...` → all tests pass; `go build -o /tmp/hr-relay .` →
exit 0.

### Step 4: Hand off the Android reachability gate

Deploy only to the trusted LAN for a manual probe from the phone's actual
walkpadspeed HTTPS origin. Confirm the browser can make an authorized request
to `GET /api/v1/hr`, including any Local Network Access prompt, and receives a
fresh JSON sample. Record the browser/version and exact failure text if
blocked. Do not disable browser protections or broaden CORS to make the probe
pass.

**Verify**: the phone receives HTTP 200; `sampleSeq` increments on each
upstream notification, while `sampleAgeMs` remains within the fresh-data
window. If the request is blocked by
mixed-content or local-network policy, stop before plan 002 and report that a
trusted HTTPS endpoint or same-origin HTTPS proxy needs a separate design.

## Test plan

- `main_test.go`, using Go's `httptest`; no BLE hardware is required.
- Run `go test ./...` and `go build -o /tmp/hr-relay .`.
- The phone smoke test in step 4 is mandatory because headless Go tests cannot
  validate Android Chrome's local-network permission and mixed-content policy.

## Done criteria

- [ ] HTTP API is disabled unless explicitly configured with a LAN listen
  address, exact allowed origin, and non-empty token.
- [ ] `/api/v1/hr` returns a coherent, mutex-protected source snapshot and
  monotonically increasing sample sequence.
- [ ] No secret, wildcard CORS, write endpoint, or internet-facing default is
  introduced.
- [ ] `go test ./...` and `go build -o /tmp/hr-relay .` both exit 0.
- [ ] The phone reachability gate passes, or the plan is marked BLOCKED with
  the browser error and secure endpoint alternatives.
- [ ] Only the in-scope `hr-relay` files changed.

## STOP conditions

- The relay implementation has materially drifted from the current state above.
- The configured LAN listener would bind to all interfaces or be publicly
  reachable without an explicit, reviewed operator decision.
- The app origin cannot access the endpoint without weakening browser security.
- Adding the endpoint requires changing the BLE central/peripheral lifecycle or
  adding a non-standard dependency; report back instead of expanding scope.

## Maintenance notes

- Keep `sampleSeq` incrementing for every sensor notification, not only BPM
  changes; the browser uses it to avoid processing one poll result repeatedly.
- Keep source freshness separate from the 60-second BLE reconnect watchdog.
- If the relay's BLE event loop changes, preserve snapshot mutex discipline and
  the API's read-only behavior.
