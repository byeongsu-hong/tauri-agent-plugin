# Repository guide for agents

`tauri-agent` is a protocol-first agent debugger for live Tauri apps. It has two
sides that must stay in sync: a Rust Tauri plugin (`src/`) and a TypeScript
control surface (`guest-js/`, `daemon/`, `mcp/`, `protocol/`, `bin/`).

## Build & verify

```bash
bun install
bun run check         # typecheck + vitest + tsup build
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test
```

`bun run check:rust` runs the three Rust commands together. Always run both the
TS and Rust gates before committing — a change on one side often has a mirror on
the other.

## Layout

- `protocol/` — shared JSON-RPC types and the `AGENT_METHODS` surface. The method
  list appears in several places (`protocol/json-rpc.ts`, `src/server.rs`,
  `src/commands.rs`, `build.rs`, `permissions/default.toml`, the MCP tool list,
  the CLI, and the README); keep them consistent.
- `guest-js/` — webview instrumentation: semantic tree, ref actions, capture
  buffers, the mutation-driven stream.
- `daemon/` — JSON-RPC client/server, session, static (jsdom) adapter, endpoint
  discovery.
- `mcp/` — stdio MCP server wrapping the debugger protocol.
- `bin/` — the `tauri-agent` and `tauri-agent-mcp` CLIs.
- `src/` — the Rust plugin: inline server, webview bridge, commands, endpoint
  registry, native screenshot.
- `examples/fixture-app/` — a real Tauri v2 app wired to the plugin by local path.

## Conventions

- The endpoint registry logic is dual-implemented (`src/endpoint.rs` and
  `daemon/endpoint.ts`) and must stay behaviorally identical.
- Security posture is dev/local-only: loopback binding, per-session token,
  explicit permissions, `eval` outside `agent:default`. Preserve it.

<!-- LATTICE_LANE: e35b607d-88b7-40bf-914c-6863171e0eba -->
