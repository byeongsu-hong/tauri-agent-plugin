# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/byeongsu-hong/tauri-agent-plugin/commits/main
