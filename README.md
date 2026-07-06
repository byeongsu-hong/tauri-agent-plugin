# tauri-plugin-agent

Agent-facing control surface for live Tauri apps. The project follows the blueprint in this repo setup: make the compact semantic tree useful first, then harden the plugin transport.

## Scope Honesty

This is not a smaller full-parity clone of `agent-browser`. If this project grows to include general screenshots, native input fallback, event streams, session routing, stale element recovery, and cross-platform transport robustness, it will become a similarly serious automation system.

The v0 stays lighter only by narrowing the problem: Tauri app-owned webview context, compact semantic tree output, snapshot-local refs, and app-local actions first.

## What v0 Contains

- TypeScript guest walker that turns useful DOM/application semantics into a compact tree.
- Snapshot-local `@ref` registry with `clickRef`, `fillRef`, and `pressKey` helpers.
- `tauri-agent` CLI command surface with `tree`, `click`, `fill`, `press`, `shot`, and `events`.
- Tauri v2 Rust plugin crate exposing the target command names and `agent_windows`.
- Permission-gated command metadata for Tauri consumers.

The live Rust-to-webview bridge, local socket, screenshot capture, native input fallback, and event streaming are intentionally scaffolded as explicit bridge-pending errors. The blueprint says the key product is the compact semantic tree; this repository starts there.

## Bun + TypeScript

This project uses Bun by default.

```bash
bun install
bun run test
bun run typecheck
bun run build
```

## Formatter Prototype

Run the CLI against static HTML while tuning output:

```bash
bun run build
bun dist-cli/tauri-agent.js tree --from-html ./screen.html
bun dist-cli/tauri-agent.js tree --from-html ./screen.html --scope '[data-view="agents"]'
```

Example output:

```text
main "Ducktape"
@1 navitem "Status" selected
@2 navitem "Agents"
@3 button "Forge"
@4 textbox "Agent name" empty focused
@5 button "Register" disabled
@6 list "Roster" 3
  @7 item "local-worker" selected
    @8 button "Inspect backing"
```

## Rust Plugin

Add the plugin to a Tauri app:

```rust
tauri::Builder::default()
  .plugin(tauri_plugin_agent::init())
  .run(tauri::generate_context!())?;
```

Commands:

- `agent_snapshot({ window, scope, mode }) -> compact text`
- `agent_action({ window, ref, action, value }) -> ok/error`
- `agent_screenshot({ window, path? }) -> image/path`
- `agent_events({ window }) -> stream placeholder`
- `agent_windows() -> known windows`

## Security Direction

The bridge is dev-only first. Keep transport local, use explicit Tauri permissions, and do not enable a release-build socket unless a consumer deliberately opts into it. Webview actions should target the app webview; native input remains a separate fallback path.
