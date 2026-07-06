# tauri-agent

Headless agent debugger for Tauri apps.

`tauri-agent` is a protocol-first control surface for agents that need to inspect, drive, and debug live Tauri applications. It is intentionally closer to an agent debugger than a tiny plugin: once screenshots, native fallback, logs, events, waiters, recording, and cross-platform transport enter scope, this is serious automation infrastructure.

## Architecture

- **Agent Debug Protocol**: JSON-RPC 2.0 command surface for `attach`, `windows`, `tree`, `click`, `fill`, `press`, `shot`, `logs`, `events`, `wait`, `state`, and `record`.
- **Daemon/Client**: Bun/TypeScript in-process and TCP line-delimited transports for headless control.
- **Guest JS Instrumentation**: semantic tree snapshots, snapshot-local `@ref` actions, console log capture, event capture, state probes, text waiters, and action recording.
- **Tauri Plugin**: opt-in inline loopback server, app-scoped endpoint registry, Tauri permissions, window discovery, and a request/response bridge into instrumented webviews.
- **CLI**: agent-facing commands backed by the same protocol path.

The live bridge supports `windows`, `tree`, `click`, `fill`, `press`, `shot`, `logs`, `events`, `wait`, `state`, and `record` against a real Tauri webview when the app installs `WebviewAgentInstrumentation`. The external inline server and direct Tauri commands both route through this bridge. `shot` currently uses a DOM-rendered SVG fallback that can return a data URL or write a `.svg` file; native pixel capture remains a separate platform-specific fallback path.

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

Endpoint policy:

- Do not use one global `/tmp/tauri-mcp.sock`.
- Publish an app-specific registry under the runtime directory, for example `.../tauri-agent/<app-id>/endpoint.json`.
- Use localhost TCP as the portable fallback and current inline-server transport.
- CLI and MCP wrappers should discover the app endpoint by app id instead of assuming a singleton socket.

Control a live app through endpoint discovery:

```bash
tauri-agent windows --app dev.byeongsu.tauri-agent.fixture
tauri-agent tree --app dev.byeongsu.tauri-agent.fixture
tauri-agent fill @4 worker-a --app dev.byeongsu.tauri-agent.fixture
tauri-agent click @5 --app dev.byeongsu.tauri-agent.fixture
tauri-agent wait "Registered worker-a" --app dev.byeongsu.tauri-agent.fixture
tauri-agent state --app dev.byeongsu.tauri-agent.fixture
```

Core command surface:

```bash
tauri-agent attach
tauri-agent windows
tauri-agent tree --window main
tauri-agent click @3
tauri-agent fill @4 worker-a
tauri-agent press Enter
tauri-agent shot /tmp/app.svg
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

Use it as the first real target for live bridge work. Its plugin config enables the inline server with an ephemeral loopback port and endpoint publication. Its UI intentionally exposes agent-testable semantics: `Status` and `Agents` navitems, `Forge`, `Agent name`, `Register`, `Roster`, and `Inspect backing`.

## Package Exports

```ts
import {
  WebviewAgentInstrumentation,
  agentEvents,
  agentLogs,
  agentRecord,
  agentSnapshot,
  agentState,
  agentWait,
  snapshotDocument
} from '@byeongsu-hong/tauri-plugin-agent'
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
agent.screenshot()
agent.logs()
agent.events()
agent.state()
```

Direct Tauri command helpers use the same bridge:

```ts
await agentSnapshot({ scope: 'main' })
await agentLogs()
await agentEvents()
await agentWait({ text: 'Ready', timeoutMs: 1000 })
await agentState()
await agentRecord({ action: 'get' })
```

## Rust Plugin

Add the plugin to a Tauri app:

```rust
tauri::Builder::default()
  .plugin(tauri_plugin_agent::init())
  .run(tauri::generate_context!())?;
```

Enable the inline server in `tauri.conf.json`:

```json
{
  "plugins": {
    "agent": {
      "inlineServer": {
        "enabled": true,
        "host": "127.0.0.1",
        "port": 0,
        "publishEndpoint": true
      }
    }
  }
}
```

Rust command names:

- `agent_bridge_response`
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
