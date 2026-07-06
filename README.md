# tauri-agent

Headless agent debugger for Tauri apps.

`tauri-agent` is a protocol-first control surface for agents that need to inspect, drive, and debug live Tauri applications. It is intentionally closer to an agent debugger than a tiny plugin: once screenshots, native fallback, logs, events, waiters, recording, and cross-platform transport enter scope, this is serious automation infrastructure.

## Architecture

- **Agent Debug Protocol**: JSON-RPC 2.0 command surface for `attach`, `windows`, `tree`, `click`, `fill`, `press`, `shot`, `logs`, `events`, `wait`, `state`, and `record`.
- **Daemon/Client**: Bun/TypeScript in-process and TCP line-delimited transports for headless control.
- **Guest JS Instrumentation**: semantic tree snapshots, snapshot-local `@ref` actions, console log capture, event capture, state probes, text waiters, and action recording.
- **Tauri Plugin**: Rust-side command names, permissions, window discovery, and protocol-shaped bridge placeholders.
- **CLI**: agent-facing commands backed by the same protocol path.

The current live Tauri bridge still needs to connect Rust webview evaluation and native screenshot/input capture to the protocol. Static HTML mode exists so the protocol, CLI, and instrumentation can be tuned deterministically while that app bridge is built.

## Bun + TypeScript

This project uses Bun by default.

```bash
bun install
bun run check
cargo fmt -- --check
cargo check
```

## CLI

Prototype against static HTML:

```bash
bun run build
bun bin/tauri-agent.ts windows --from-html ./screen.html
bun bin/tauri-agent.ts tree --from-html ./screen.html
bun bin/tauri-agent.ts fill @4 worker-a --from-html ./screen.html
bun bin/tauri-agent.ts wait "Registered" --from-html ./screen.html
bun bin/tauri-agent.ts state --from-html ./screen.html
bun bin/tauri-agent.ts record --from-html ./screen.html
```

Serve the JSON-RPC daemon:

```bash
bun bin/tauri-agent.ts serve --from-html ./screen.html --port 45127
```

Core command surface:

```bash
tauri-agent attach
tauri-agent windows
tauri-agent tree --window main
tauri-agent click @3
tauri-agent fill @4 worker-a
tauri-agent press Enter
tauri-agent shot /tmp/app.png
tauri-agent logs --follow
tauri-agent events --follow
tauri-agent wait "Registered"
tauri-agent state
tauri-agent record --action start
```

## Fixture App

`examples/fixture-app` is a minimal Bun + TypeScript + Tauri v2 app wired to this plugin by local path.

```bash
cd examples/fixture-app
bun install
bun run build
cargo check --manifest-path src-tauri/Cargo.toml
bun run tauri:dev
```

Use it as the first real target for live bridge work. Its UI intentionally exposes agent-testable semantics: `Status` and `Agents` navitems, `Forge`, `Agent name`, `Register`, `Roster`, and `Inspect backing`.

## Package Exports

```ts
import { WebviewAgentInstrumentation, snapshotDocument } from '@byeongsu-hong/tauri-plugin-agent'
import { DebuggerClient, SocketTransport } from '@byeongsu-hong/tauri-plugin-agent/daemon'
import { AGENT_METHODS } from '@byeongsu-hong/tauri-plugin-agent/protocol'
```

## Guest Instrumentation

```ts
import { WebviewAgentInstrumentation } from '@byeongsu-hong/tauri-plugin-agent'

const agent = new WebviewAgentInstrumentation({
  state: {
    route: () => location.pathname
  }
})

agent.install()
agent.snapshot()
agent.action({ action: 'click', ref: '@3' })
agent.logs()
agent.events()
agent.state()
```

## Rust Plugin

Add the plugin to a Tauri app:

```rust
tauri::Builder::default()
  .plugin(tauri_plugin_agent::init())
  .run(tauri::generate_context!())?;
```

Rust command names:

- `agent_attach`
- `agent_snapshot`
- `agent_action`
- `agent_screenshot`
- `agent_logs`
- `agent_events`
- `agent_windows`
- `agent_wait`
- `agent_state`
- `agent_record`

## Security Direction

Default posture is dev-only and local-only. The live bridge must use explicit Tauri permissions, bind local sockets only, and keep webview actions scoped to the app. Native input remains a separate fallback path and should not become arbitrary system UI control without a deliberate opt-in.
