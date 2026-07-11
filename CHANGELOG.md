# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Network/IPC summaries now support retained `id` detail lookup with automatic
  secret redaction and a 64 KiB value cap.
- Atomic actions return a `traceId` copied onto synchronous logs, events,
  network requests, and IPC invokes.
- `tauri-agent diagnose` and `tauri_diagnose` collect a compact cross-surface
  report using the existing protocol methods; passing an action `traceId`
  filters its effects and expands retained network/IPC details.

### Changed

- Agent protocol v2 makes logs/events/network/IPC consistently return
  `{ entries, cursor, dropped }`; legacy bare-array capture responses are removed.

### Fixed

- IPC tracing now captures Tauri v2's immutable custom-protocol invoke path
  instead of depending on replacing the read-only `__TAURI_INTERNALS__.invoke`.
- Static/serve JSON-RPC now rejects malformed parameter types with
  `INVALID_PARAMS` and preserves all supported location actions.
- Static state snapshots now report the current `document.title`, matching live
  webviews after scripts change the page title.
- MCP tool calls now return `-32602` for malformed params, arguments, and
  typed connection fields instead of silently applying defaults.
- MCP numeric schemas and request validation now enforce protocol-safe integer
  bounds for cursors, limits, timeouts, polling intervals, and ports.
- MCP tool calls now enforce advertised scalar, union, enum, array, and
  upload-object schemas before opening a debugger connection.
- MCP uploads now advertise and enforce at least one file.
- Per-call MCP tools now require exactly one connection source and reject
  ambiguous targets or `host` without `port`.
- Shared CLI and configured MCP targets now enforce the same single-source rule,
  reject invalid ports, and only accept `host` alongside `port`.
- MCP window and atomic-action tools now reject missing action-specific values
  and locators before opening a debugger connection.
- MCP capture tools now reject conflicting follow, detail, and list options
  instead of silently ignoring them or failing after connection.
- MCP storage, cookie, and location tools now enforce action-specific required
  fields before opening a debugger connection.
- MCP wait tools now require one coherent locator, function, or network-idle
  mode and reject options that would otherwise be ignored.
- Static daemon and MCP window controls now enforce the same `i32` position and
  positive `u32` size bounds as the Rust plugin.
- Live bridge requests now return `INVALID_PARAMS` for malformed scalar,
  enum, upload, and modifier fields; legacy `value` aliases are removed.
- Typed Tauri commands now omit absent/null bridge fields and canonicalize
  generic actions to `text`/`key` before reaching the strict guest bridge.
- Ref and atomic actions now reject missing or action-incompatible values
  instead of converting them to empty text or a checked state.
- The Rust inline JSON-RPC server now rejects explicit null, array, and scalar
  `params` envelopes consistently with the TypeScript daemon.
- Debugger clients now reject malformed, ambiguous, and mismatched JSON-RPC
  response envelopes instead of trusting unchecked response casts.
- TypeScript socket transports now preserve UTF-8 characters split across TCP
  chunks and enforce request limits per byte-counted line.
- TypeScript line servers now match Rust by returning `INVALID_REQUEST` before
  closing an oversized request connection.
- TypeScript line servers now match Rust's 30-second idle timeout and 64-client
  concurrent connection cap.
- TypeScript line servers now process each connection in request order, preserve
  earlier responses before oversized-line errors, and pause idle timeouts while
  a request is executing. Socket reads and subsequent requests now wait for
  response writes to flush instead of growing the writable buffer unchecked.
- TypeScript JSON-RPC errors now preserve valid request ids for unknown methods,
  matching the Rust inline server.
- Agent, MCP, and Rust JSON-RPC boundaries now require numeric ids to be safe
  integers, preventing fractional, infinite, or precision-losing ids from
  changing during parsing and serialization.
- Static `serve` mode now binds only to `127.0.0.1`; its unauthenticated daemon
  can no longer be exposed through a configurable host.
- TypeScript socket clients now cap newline-delimited responses at 64 MiB so a
  malformed peer cannot grow the receive buffer until timeout.
- TypeScript endpoint registries now match Rust's integer and optional-field
  validation and use atomic owner-only file replacement.
- MCP requests now reject invalid JSON-RPC ids plus malformed initialize and
  tools/list params instead of accepting or ignoring them.
- MCP stdio now caps newline-delimited requests by UTF-8 byte length and
  recovers cleanly after discarding an oversized line.
- CLI replay now validates every recording method and params object before
  executing any action, preventing partial or defaulted replays.
- Static and live bridges now require non-negative safe integers for cursor,
  limit, timeout, and idle-duration fields, matching unsigned semantics without
  accepting values JavaScript cannot represent precisely.
- MCP tool calls now enforce each advertised required and additional-property
  rule before connecting to or mutating a debugger target.

## [0.0.2] - 2026-07-11

### Added

- **Runtime selection.** Wry remains the default; CEF apps can disable default
  features and enable the `cef` feature without pulling in Wry.

### Changed

- Published artifacts now match the repository name: the Rust crate is
  `tauri-agent-plugin` and the npm package is
  `@byeongsu-hong/tauri-agent-plugin`. The `agent:*` permission namespace and
  `plugin:agent|*` IPC routes are unchanged.

### Fixed

- Adding a second webview no longer makes a healthy guest registration disappear
  from bridge targeting and window discovery.
- Guest instrumentation now keeps installing when Tauri exposes its optional IPC
  tracing hook as read-only, as Wry does.

## [0.0.1] - 2026-07-08

### Added

- **VNC advertise-only surface.** Optional `vnc` plugin config published into the
  app's `endpoint.json` so a fleet viewer can discover a human-facing VNC/noVNC
  visual surface alongside the debugger transport. Adds a `tauri-agent vnc` CLI
  command. The plugin only advertises; the surrounding harness runs the VNC server.
- **DOM semantic-tree push stream.** A `MutationObserver`-driven diff stream
  (`stream` method, `tauri-agent stream` CLI, `tauri_stream` MCP tool, `agentStream`
  helper) that emits added/removed compact-tree lines against a monotonic cursor
  with long-poll delivery — no polling loop at the source.
- **`agent:readonly` permission set** for adopters that want a non-mutating subset.
- Dual-license texts (`LICENSE-MIT`, `LICENSE-APACHE`).

### Changed / Security

- **Inline server now authenticates every request** with a per-session token
  published in the (`0600` on Unix) endpoint registry; discovery clients send it
  automatically.
- **Loopback enforced.** A non-loopback `inlineServer.host` is rejected unless the
  new `allowNonLoopback` opt-in is set.
- **`eval` removed from `agent:default`;** it must now be granted explicitly via
  `agent:allow-agent-eval`.
- Bridge request ids carry a random suffix so one webview cannot forge another
  window's response.
- Dot-only app ids are neutralized so a crafted `--app` cannot escape the runtime
  registry directory.
- Bridge long-poll budget capped at 60s; the pending-response map no longer leaks
  when an emit fails.
- Inline TCP server bounds its surface: per-connection read timeout, max request
  line length, concurrent-connection cap.
- Endpoint registry is written atomically and cleaned up only on real `Exit`
  (never the vetoable `ExitRequested`), and only by the instance that published it.
- Richer error taxonomy (`INVALID_PARAMS`, `TIMEOUT`, `IO_ERROR`,
  `UNSUPPORTED_PLATFORM`) instead of collapsing everything to `BRIDGE_UNAVAILABLE`.
- `console.log` is now captured; object/Error console arguments are serialized.
- `resolveRef` fails loudly on a detached element instead of acting as a no-op.
- Daemon socket survives client resets; `SocketTransport` no longer hangs forever
  on a server that never replies; MCP stdio no longer serializes behind long-polls.
- Guest capture buffers (logs/events/network/recordings) are bounded.

### Packaging

- `prepublishOnly`, `publishConfig.access`, `engines`, `keywords`, `sideEffects`;
  Cargo `include`/`keywords`/`categories`/`readme` so `cargo publish` ships only
  the crate.
- macOS-only native-screenshot helpers are `cfg`-gated so clippy is clean on
  Linux/Windows.

[Unreleased]: https://github.com/byeongsu-hong/tauri-agent-plugin/compare/v0.0.2...HEAD
[0.0.2]: https://github.com/byeongsu-hong/tauri-agent-plugin/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/byeongsu-hong/tauri-agent-plugin/releases/tag/v0.0.1
