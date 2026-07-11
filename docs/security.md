# Security

The default posture is **dev-only and local-only**. The live bridge uses
explicit Tauri permissions, binds loopback sockets only, and keeps webview
actions scoped to the app. This document is fact, not aspiration — each control
below is enforced in code and covered by tests.

## Transport authentication

The inline server binds a loopback socket that **any local process can reach**
(loopback is not user-scoped), so it authenticates every request with a
per-session token:

- The plugin generates a random token at startup and publishes it in the app's
  `endpoint.json`, written `0600` on Unix and via a pid-scoped temp file +
  atomic rename.
- Every request must carry the token; the CLI and MCP read it automatically
  during endpoint discovery. A client dialing a known `--port`/`--host` daemon
  directly sends no token (it opted into a trusted local daemon).

## Network exposure

- **Loopback only.** A non-loopback host (e.g. `0.0.0.0`) is rejected unless the
  explicit `allowNonLoopback` plugin-config opt-in is set.
- **Release gating.** The inline server runs in debug builds when enabled;
  release builds require the explicit `allowReleaseSocket` opt-in before binding
  a debugger socket.
- **Bounded surface.** Per-connection read timeout, max request-line size, a
  concurrent-connection cap, and join-on-shutdown bound the TCP surface against
  a stalled or abusive local client.

## Permission model

Bridge commands are gated by Tauri's ACL. Three sets ship:

- **`agent:default`** — the mutating + read command set, **excluding `eval`**.
- **`agent:readonly`** — a non-mutating subset (attach, windows, tree, find,
  inspect, screenshot, logs/events/network/ipc, state, wait, expect, stream) for
  cautious adopters.
- **`agent:allow-agent-eval`** — `eval` is arbitrary in-webview code execution,
  so it is never in `default` and must be granted explicitly.

## Webview integrity

- **Unforgeable bridge ids.** Bridge request ids carry a random suffix and the
  responding window label is verified, so one webview cannot spoof another
  window's bridge response.
- **App-id sanitization.** Registry paths sanitize the app id (dot-only ids are
  neutralized) so a crafted id cannot escape the runtime directory. Rust and TS
  implementations are locked together by a golden fixture.

## Native surfaces

- Native screenshots are explicit through `backend: "native"` / `backend:
  "auto"` and remain app-window scoped; off macOS they return a distinct
  `UNSUPPORTED_PLATFORM` error rather than silently doing something else.
- The plugin never binds a VNC port — the `vnc` config only advertises where a
  separately-run stream lives.

## Captured detail

- Capture lists contain summaries only. Network headers/bodies and IPC
  args/results require an explicit retained-entry id.
- Authorization, cookies, credentials, passwords, sessions, tokens, secrets,
  and API keys are replaced with `[REDACTED]`; sensitive URL query parameters
  are redacted too.
- Each stored body/value is capped at 64 KiB, and detail buffers remain bounded
  with the summary capture buffers.

## Error taxonomy

Failures carry distinct wire codes so agents can branch on retryable vs not:
`STALE_REF`, `INVALID_PARAMS`, `WINDOW_NOT_FOUND`, `TIMEOUT`, `IO_ERROR`,
`UNSUPPORTED_PLATFORM`, `BRIDGE_UNAVAILABLE`, `UNAUTHORIZED`. A malformed ref is
`INVALID_PARAMS` (fix the argument), not `STALE_REF` (re-snapshot).
