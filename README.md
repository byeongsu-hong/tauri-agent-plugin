# tauri-agent

Headless agent debugger for Tauri apps.

`tauri-agent` is a protocol-first control surface for agents that need to inspect, drive, and debug live Tauri applications. It is intentionally closer to an agent debugger than a tiny plugin: once screenshots, native fallback, logs, events, waiters, recording, and cross-platform transport enter scope, this is serious automation infrastructure.

## Architecture

- **Agent Debug Protocol**: JSON-RPC 2.0 command surface for `attach`, `windows`, `tree`, `find`, `click`, `hover`, `focus`, `blur`, `scroll`, `drag`, `fill`, `select`, `check`, `inspect`, `eval`, `press`, `shot`, `logs`, `events`, `network`, `storage`, `cookies`, `location`, `wait`, `state`, and `record`.
- **Daemon/Client**: Bun/TypeScript in-process and TCP line-delimited transports for headless control.
- **MCP Server**: stdio Model Context Protocol wrapper exposing debugger tools for agents.
- **Guest JS Instrumentation**: semantic tree snapshots, snapshot-local `@ref` finding/inspection/actions, hover, focus, blur, scroll, and drag events, select and checked control changes, JavaScript evaluation, console/runtime error/unhandled rejection log capture, event capture, fetch network metadata capture, local/session storage access, webview-visible cookie access, SPA location control, state probes, text and semantic waiters, and action recording.
- **Tauri Plugin**: opt-in inline loopback server, app-scoped endpoint registry, Tauri permissions, window discovery, and a request/response bridge into instrumented webviews.
- **CLI**: agent-facing commands backed by the same protocol path.

The live bridge supports `windows`, `tree`, `find`, `click`, `hover`, `focus`, `blur`, `scroll`, `drag`, `fill`, `select`, `check`, `inspect`, `eval`, `press`, `shot`, `logs`, `events`, `network`, `storage`, `cookies`, `location`, `wait`, `state`, and `record` against a real Tauri webview when the app installs `WebviewAgentInstrumentation`. The external inline server and direct Tauri commands both route through this bridge. `find` refreshes the semantic snapshot and returns inspect-shaped matches by role, accessible-name substring, visible-text substring, and optional limit so agents can obtain refs without parsing tree text. `wait` can poll for plain text or for the first semantic match by scope, role, accessible-name substring, and visible-text substring; semantic waits return the matched inspect-shaped entry under `match`. `hover` dispatches `mouseover`, `mouseenter`, and `mousemove` against a snapshot-local ref. `focus` moves document focus to a snapshot-local ref before keyboard actions. `blur` removes focus from a snapshot-local ref. `scroll` adjusts a snapshot-local ref by optional `x`/`y` deltas and dispatches a scroll event. `drag` dispatches a semantic drag sequence from one snapshot-local ref to another optional target ref. `select` chooses an option by value or visible label from a `combobox` ref, or directly from an `option` ref. `check` sets native checkbox/radio state idempotently. `eval` is intended for dev-only local debugging and returns `{ type, text, value? }`, with `value` included only when the result can be represented as JSON. `logs` returns captured console messages plus uncaught browser `error` and `unhandledrejection` entries as error-level logs. `network` captures non-Tauri-IPC fetch metadata only: method, URL, status, timing, error text, and request/response byte sizes when measurable without consuming the returned response. `storage` reads or mutates `localStorage`/`sessionStorage` with `get`, `set`, `remove`, and `clear`, returning the resulting key/value entries. `cookies` reads or mutates webview-visible `document.cookie` entries with `get`, `set`, `remove`, and `clear`, returning parsed `{ name, value }` entries; native and HttpOnly cookie-store access is outside this webview bridge path. `location` returns `{ href, origin, pathname, search, hash }` and can `push` or `replace` SPA routes without reloading the webview. `shot` currently uses a DOM-rendered SVG fallback that can return a data URL or write a `.svg` file; native pixel capture remains a separate platform-specific fallback path.

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
bun bin/tauri-agent.ts find --role button --name Forge --from-html ./screen.html
bun bin/tauri-agent.ts inspect @4 --from-html ./screen.html
bun bin/tauri-agent.ts eval "document.title" --from-html ./screen.html
bun bin/tauri-agent.ts hover @3 --from-html ./screen.html
bun bin/tauri-agent.ts focus @4 --from-html ./screen.html
bun bin/tauri-agent.ts blur @4 --from-html ./screen.html
bun bin/tauri-agent.ts scroll @7 12 --from-html ./screen.html
bun bin/tauri-agent.ts drag @3 @8 --from-html ./screen.html
bun bin/tauri-agent.ts fill @4 worker-a --from-html ./screen.html
bun bin/tauri-agent.ts select @3 remote --from-html ./screen.html
bun bin/tauri-agent.ts check @6 true --from-html ./screen.html
bun bin/tauri-agent.ts wait "Registered" --from-html ./screen.html
bun bin/tauri-agent.ts wait --role button --name Forge --from-html ./screen.html
bun bin/tauri-agent.ts state --from-html ./screen.html
bun bin/tauri-agent.ts network --from-html ./screen.html
bun bin/tauri-agent.ts logs --clear --from-html ./screen.html
bun bin/tauri-agent.ts events --clear --from-html ./screen.html
bun bin/tauri-agent.ts storage --action set --key agent.token --value ready --from-html ./screen.html
bun bin/tauri-agent.ts cookies --action set --name agent.cookie --value ready --from-html ./screen.html
bun bin/tauri-agent.ts location --action push --url /agents --from-html ./screen.html
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
tauri-agent find --role button --name Forge --app dev.byeongsu.tauri-agent.fixture
tauri-agent inspect @4 --app dev.byeongsu.tauri-agent.fixture
tauri-agent eval "document.title" --app dev.byeongsu.tauri-agent.fixture
tauri-agent hover @3 --app dev.byeongsu.tauri-agent.fixture
tauri-agent focus @4 --app dev.byeongsu.tauri-agent.fixture
tauri-agent blur @4 --app dev.byeongsu.tauri-agent.fixture
tauri-agent scroll @11 12 --app dev.byeongsu.tauri-agent.fixture
tauri-agent drag @3 @18 --app dev.byeongsu.tauri-agent.fixture
tauri-agent fill @4 worker-a --app dev.byeongsu.tauri-agent.fixture
tauri-agent select @5 remote --app dev.byeongsu.tauri-agent.fixture
tauri-agent check @9 true --app dev.byeongsu.tauri-agent.fixture
tauri-agent click @3 --app dev.byeongsu.tauri-agent.fixture
tauri-agent wait "Registered worker-a" --app dev.byeongsu.tauri-agent.fixture
tauri-agent wait --role button --name Forge --app dev.byeongsu.tauri-agent.fixture
tauri-agent state --app dev.byeongsu.tauri-agent.fixture
tauri-agent network --app dev.byeongsu.tauri-agent.fixture
tauri-agent logs --clear --app dev.byeongsu.tauri-agent.fixture
tauri-agent events --clear --app dev.byeongsu.tauri-agent.fixture
tauri-agent storage --action set --key fixture:lastSelfTest --value main --app dev.byeongsu.tauri-agent.fixture
tauri-agent cookies --action set --name fixture:lastSelfTest --value main --app dev.byeongsu.tauri-agent.fixture
tauri-agent location --action push --url '/agents?bridge=1' --app dev.byeongsu.tauri-agent.fixture
```

Core command surface:

```bash
tauri-agent attach
tauri-agent windows
tauri-agent tree --window main --mode verbose
tauri-agent find --role button --name Forge --limit 1
tauri-agent click @3
tauri-agent hover @3
tauri-agent focus @4
tauri-agent blur @4
tauri-agent scroll @11 12
tauri-agent drag @3 @18
tauri-agent fill @4 worker-a
tauri-agent select @5 remote
tauri-agent check @6 true
tauri-agent inspect @4
tauri-agent eval "document.title"
tauri-agent press Enter
tauri-agent shot /tmp/app.svg
tauri-agent logs --follow
tauri-agent logs --clear
tauri-agent events --follow
tauri-agent events --clear
tauri-agent network --follow
tauri-agent storage --area session --action get
tauri-agent cookies --action get
tauri-agent location --action push --url /agents
tauri-agent wait "Registered"
tauri-agent wait --role button --name Forge
tauri-agent state
tauri-agent record --action start
```

Commands that operate on a specific webview also accept `--window <label>` to target a Tauri window by label.
`tree --interactive` polls the debugger endpoint and streams changed semantic tree snapshots as newline-delimited JSON. `logs --follow`, `events --follow`, and `network --follow` poll the debugger endpoint and stream new entries as newline-delimited JSON. Use `logs --clear`, `events --clear`, or `network --clear` to read and reset captured buffers. Use `--timeout-ms <ms>` for bounded polling sessions in scripts or tests. `shot` results include `width` and `height` metadata alongside the SVG data URL or output path.

## MCP

Run the MCP server over stdio:

```bash
tauri-agent-mcp
```

It exposes named tools mirroring the debugger protocol:

- `tauri_attach`
- `tauri_windows`
- `tauri_tree`
- `tauri_find`
- `tauri_click`
- `tauri_hover`
- `tauri_focus`
- `tauri_blur`
- `tauri_scroll`
- `tauri_drag`
- `tauri_fill`
- `tauri_select`
- `tauri_check`
- `tauri_inspect`
- `tauri_eval`
- `tauri_press`
- `tauri_shot`
- `tauri_logs`
- `tauri_events`
- `tauri_network`
- `tauri_storage`
- `tauri_cookies`
- `tauri_location`
- `tauri_wait`
- `tauri_state`
- `tauri_record`

Each tool accepts the same connection inputs as the CLI: `app` for endpoint discovery, `port`/`host` for a known debugger daemon, or `html`/`fromHtml` for deterministic static prototyping. MCP never assumes a singleton `/tmp/tauri-mcp.sock`; live calls should use the app-scoped endpoint registry.

## Fixture App

`examples/fixture-app` is a minimal Bun + TypeScript + Tauri v2 app wired to this plugin by local path.

```bash
cd examples/fixture-app
bun install
bun run build
cargo check --manifest-path src-tauri/Cargo.toml
bun run tauri:dev
```

Use it as the first real target for live bridge work. Its plugin config enables the inline server with an ephemeral loopback port and endpoint publication. It opens `main` and `secondary` windows so `--window` targeting can be tested against real webviews. Its UI intentionally exposes agent-testable semantics: `Status` and `Agents` navitems, `Forge`, `Agent name`, `Register`, `Roster`, and `Inspect backing`.

## Package Exports

```ts
import {
  WebviewAgentInstrumentation,
  agentBlur,
  agentCheck,
  agentCookies,
  agentDrag,
  agentEvents,
  agentEval,
  agentFind,
  agentFocus,
  agentHover,
  agentLogs,
  agentLocation,
  agentInspect,
  agentNetwork,
  agentRecord,
  agentScroll,
  agentSnapshot,
  agentSelect,
  agentState,
  agentStorage,
  agentWait,
  snapshotDocument
} from '@byeongsu-hong/tauri-plugin-agent'
import { DebuggerClient, SocketTransport } from '@byeongsu-hong/tauri-plugin-agent/daemon'
import { createMcpRequestHandler } from '@byeongsu-hong/tauri-plugin-agent/mcp'
import { AGENT_METHODS } from '@byeongsu-hong/tauri-plugin-agent/protocol'
```

## Guest Instrumentation

```ts
import { WebviewAgentInstrumentation } from '@byeongsu-hong/tauri-plugin-agent'

const agent = new WebviewAgentInstrumentation({
  windowLabel: 'main',
  state: {
    route: () => location.pathname
  }
})

agent.install()
agent.snapshot()
agent.find({ role: 'button', name: 'Forge', limit: 1 })
agent.action({ action: 'click', ref: '@3' })
agent.hover('@3')
agent.focus('@4')
agent.blur('@4')
agent.scroll('@11', { y: 12 })
agent.drag('@3', { toRef: '@18' })
agent.select('@5', 'remote')
agent.check('@6', true)
agent.evaluate('document.title')
agent.screenshot()
agent.logs()
agent.events()
agent.network({ clear: true })
agent.storage({ action: 'set', key: 'agent.token', value: 'ready' })
agent.cookies({ action: 'set', name: 'agent.cookie', value: 'ready' })
agent.location({ action: 'push', url: '/agents' })
agent.state()
```

Direct Tauri command helpers use the same bridge:

```ts
await agentSnapshot({ scope: 'main' })
await agentFind({ role: 'button', name: 'Forge', limit: 1 })
await agentInspect({ ref: '@4' })
await agentEval({ code: 'document.title' })
await agentHover({ ref: '@3' })
await agentFocus({ ref: '@4' })
await agentBlur({ ref: '@4' })
await agentScroll({ ref: '@11', y: 12 })
await agentDrag({ ref: '@3', toRef: '@18' })
await agentSelect({ ref: '@5', value: 'remote' })
await agentCheck({ ref: '@6', checked: true })
await agentLogs({ clear: true })
await agentEvents({ clear: true })
await agentNetwork({ clear: true })
await agentStorage({ action: 'set', key: 'agent.token', value: 'ready' })
await agentCookies({ action: 'set', name: 'agent.cookie', value: 'ready' })
await agentLocation({ action: 'push', url: '/agents' })
await agentWait({ text: 'Ready', timeoutMs: 1000 })
await agentWait({ role: 'button', name: 'Forge', timeoutMs: 1000 })
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
- `agent_find`
- `agent_action`
- `agent_inspect`
- `agent_eval`
- `agent_select`
- `agent_check`
- `agent_hover`
- `agent_focus`
- `agent_blur`
- `agent_scroll`
- `agent_drag`
- `agent_screenshot`
- `agent_logs`
- `agent_events`
- `agent_network`
- `agent_storage`
- `agent_cookies`
- `agent_location`
- `agent_windows`
- `agent_wait`
- `agent_state`
- `agent_record`

## Security Direction

Default posture is dev-only and local-only. The live bridge must use explicit Tauri permissions, bind local sockets only, and keep webview actions scoped to the app. `eval` is permission-gated with the other bridge commands and should remain a local debugging primitive, not a production remote-code execution surface. Native input remains a separate fallback path and should not become arbitrary system UI control without a deliberate opt-in.
