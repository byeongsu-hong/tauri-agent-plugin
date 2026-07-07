# tauri-agent

Headless agent debugger for Tauri apps.

`tauri-agent` is a protocol-first control surface for agents that need to inspect, drive, and debug live Tauri applications. It is intentionally closer to an agent debugger than a tiny plugin: once screenshots, native fallback, logs, events, waiters, recording, and cross-platform transport enter scope, this is serious automation infrastructure.

## Architecture

- **Agent Debug Protocol**: JSON-RPC 2.0 command surface for `attach`, `windows`, `window`, `tree`, `find`, `click`, `hover`, `focus`, `blur`, `scroll`, `drag`, `fill`, `select`, `check`, `inspect`, `eval`, `press`, `shot`, `logs`, `events`, `network`, `storage`, `cookies`, `location`, `wait`, `state`, and `record`.
- **Daemon/Client**: Bun/TypeScript in-process and TCP line-delimited transports for headless control.
- **MCP Server**: stdio Model Context Protocol wrapper exposing debugger tools for agents.
- **Guest JS Instrumentation**: semantic tree snapshots, snapshot-local `@ref` finding/inspection/actions, hover, focus, blur, scroll, and drag events, select and checked control changes, JavaScript evaluation, console/runtime error/unhandled rejection log capture, event capture, fetch network metadata capture, local/session storage access, webview-visible cookie access, SPA location control, state probes, text and semantic waiters, and action recording.
- **Tauri Plugin**: opt-in inline loopback server, app-scoped endpoint registry, Tauri permissions, window discovery/control, and a request/response bridge into instrumented webviews.
- **CLI**: agent-facing commands backed by the same protocol path.

The live bridge supports `windows`, `window`, `tree`, `find`, `click`, `hover`, `focus`, `blur`, `scroll`, `drag`, `fill`, `select`, `check`, `inspect`, `eval`, `press`, `shot`, `logs`, `events`, `network`, `storage`, `cookies`, `location`, `wait`, `state`, and `record` against a real Tauri webview when the app installs `WebviewAgentInstrumentation`. The external inline server and direct Tauri commands both route through this bridge. `windows` returns labels, titles, focus/visibility state, minimized/maximized state, scale factor, and inner/outer bounds when the host platform reports them. `window` reads or controls one native Tauri window with `get`, `focus`, `show`, `hide`, `minimize`, `unminimize`, `maximize`, `unmaximize`, `setSize`, and `setPosition`, then returns the updated window metadata. `find` refreshes the semantic snapshot and returns inspect-shaped matches by role, accessible-name substring, visible-text substring, and optional limit so agents can obtain refs without parsing tree text. `wait` can poll for plain text or for the first semantic match by scope, role, accessible-name substring, and visible-text substring; semantic waits return the matched inspect-shaped entry under `match`. `hover` dispatches `mouseover`, `mouseenter`, and `mousemove` against a snapshot-local ref. `focus` moves document focus to a snapshot-local ref before keyboard actions. `blur` removes focus from a snapshot-local ref. `scroll` adjusts a snapshot-local ref by optional `x`/`y` deltas and dispatches a scroll event. `drag` dispatches a semantic drag sequence from one snapshot-local ref to another optional target ref. `select` chooses an option by value or visible label from a `combobox` ref, or directly from an `option` ref. `check` sets native checkbox/radio state idempotently. `press` dispatches a keyboard key to the active element, or focuses a snapshot-local `ref` first, with optional `Alt`, `Control`, `Meta`, and `Shift` modifiers. `eval` is intended for dev-only local debugging and returns `{ type, text, value? }`, with `value` included only when the result can be represented as JSON. `logs` returns captured console messages plus uncaught browser `error` and `unhandledrejection` entries as error-level logs. `network` captures non-Tauri-IPC fetch metadata only: method, URL, status, timing, error text, and request/response byte sizes when measurable without consuming the returned response. `storage` reads or mutates `localStorage`/`sessionStorage` with `get`, `set`, `remove`, and `clear`, returning the resulting key/value entries. `cookies` reads or mutates webview-visible `document.cookie` entries with `get`, `set`, `remove`, and `clear`, returning parsed `{ name, value }` entries; native and HttpOnly cookie-store access is outside this webview bridge path. `location` returns `{ href, origin, pathname, search, hash }` and can `push` or `replace` SPA routes without reloading the webview. `shot` defaults to the DOM-rendered SVG bridge path for deterministic output and can opt into `backend: "native"` for macOS window pixel capture or `backend: "auto"` to try native capture before falling back to DOM.

## Quickstart (add to your Tauri app)

1. **Add the crate** to `src-tauri/Cargo.toml` and register the plugin:

   ```rust
   tauri::Builder::default()
     .plugin(tauri_plugin_agent::init())
     .run(tauri::generate_context!())?;
   ```

2. **Grant the permission** in `src-tauri/capabilities/*.json`. Without this,
   every `plugin:agent|*` invoke fails with a permissions error:

   ```json
   { "permissions": ["core:default", "agent:default"] }
   ```

   Use `agent:readonly` for a non-mutating subset, and add
   `agent:allow-agent-eval` only if you need `eval`.

3. **Install the guest instrumentation** in your frontend. Bridge commands
   (`tree`, `click`, …) hang until the webview calls `install()`:

   ```ts
   import { WebviewAgentInstrumentation } from '@byeongsu-hong/tauri-plugin-agent'
   new WebviewAgentInstrumentation({ windowLabel: 'main' }).install()
   ```

4. **Enable the inline server** (below) if you want out-of-process control via the
   CLI/MCP, then **verify the wiring**:

   ```bash
   tauri-agent attach --app <your.app.identifier>
   ```

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
bun bin/tauri-agent.ts window --action setSize --width 800 --height 600 --from-html ./screen.html
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
bun bin/tauri-agent.ts state --key values --from-html ./screen.html
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
tauri-agent window --window secondary --action setSize --width 720 --height 560 --app dev.byeongsu.tauri-agent.fixture
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
tauri-agent state --key probes --app dev.byeongsu.tauri-agent.fixture
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
tauri-agent press k --ref @4 --modifier Meta --modifier Shift
tauri-agent shot /tmp/app.svg
tauri-agent shot /tmp/app.png --backend native
tauri-agent shot --backend auto
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
tauri-agent state --key values
tauri-agent record --action start
tauri-agent stream --timeout-ms 5000
```

Commands that operate on a specific webview also accept `--window <label>` to target a Tauri window by label.
`tree --interactive` polls the debugger endpoint and streams changed semantic tree snapshots as newline-delimited JSON. `logs --follow`, `events --follow`, and `network --follow` poll the debugger endpoint and stream new entries as newline-delimited JSON. Use `logs --clear`, `events --clear`, or `network --clear` to read and reset captured buffers. Use `state --key <field>` to return one top-level state field such as `values` or `probes`; missing keys return `null`. Use `--timeout-ms <ms>` for bounded polling sessions in scripts or tests. `shot` results include `width` and `height` metadata alongside the SVG or PNG data URL or output path. `--backend dom` preserves the default SVG bridge path, `--backend native` captures macOS window pixels through the Tauri `NSWindow`, and `--backend auto` falls back to DOM if native capture is unavailable.

## MCP

Run the MCP server over stdio:

```bash
tauri-agent-mcp
```

It exposes named tools mirroring the debugger protocol:

- `tauri_attach`
- `tauri_windows`
- `tauri_window`
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
- `tauri_stream`

Each tool accepts the same connection inputs as the CLI: `app` for endpoint discovery, `port`/`host` for a known debugger daemon, or `html`/`fromHtml` for deterministic static prototyping. MCP never assumes a singleton `/tmp/tauri-mcp.sock`; live calls should use the app-scoped endpoint registry.

`tauri_shot` accepts `backend` as `dom`, `native`, or `auto`. Static HTML prototyping supports `dom` and `auto`; explicit `native` requires a live Tauri window.

`tauri_logs`, `tauri_events`, and `tauri_network` support bounded follow polling through `follow`, `pollMs`, and `timeoutMs`. MCP tool calls return one accumulated result instead of an unbounded stream, which keeps agent requests finite while still allowing live tailing.

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
  agentAction,
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
  agentScreenshot,
  agentScroll,
  agentSnapshot,
  agentSelect,
  agentState,
  agentStorage,
  agentStream,
  agentWait,
  agentWindow,
  agentWindows,
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
agent.action({ action: 'press', ref: '@4', value: 'k', modifiers: ['Meta', 'Shift'] })
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
await agentAction({ action: 'press', ref: '@4', value: 'k', modifiers: ['Meta', 'Shift'] })
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

## Surfaces

`tauri-agent` exposes two surfaces for the same running app:

- **Agent surface (DOM/semantic):** the committed-DOM semantic tree with `@ref`
  based actions (`click @2`, `type @1 "..."`). This is the primary surface for
  agents and is served over the inline debugger endpoint. A live push stream of
  semantic-tree diffs is available via `stream` — a `MutationObserver` in the
  guest drives diff frames (no polling loop), and consumers drain them against a
  monotonic cursor, long-polling for the next change:

  ```bash
  tauri-agent stream --app dev.byeongsu.tauri-agent.fixture
  ```

  The first line is the full compact tree (`{ snapshot, cursor }`); each
  subsequent line is a change frame (`{ seq, added, removed }`). Pass
  `--since <cursor>` to resume and `--wait-ms`/`--timeout-ms` to bound polling.
- **Human surface (VNC/noVNC):** a visual view of the app for QA — "how does the
  screen actually look right now". The plugin does not run a VNC server itself;
  it only **advertises** where the stream lives so a viewer can discover it. The
  surrounding harness runs the VNC server (for example `x11vnc` + `websockify`
  against the app's virtual display).

Advertise the VNC surface by adding a `vnc` block to the plugin config. It is
published into the app's `endpoint.json` registry alongside the debugger
transport, so a fleet viewer can discover both surfaces by app id:

```json
{
  "plugins": {
    "agent": {
      "inlineServer": { "enabled": true, "host": "127.0.0.1", "port": 0 },
      "vnc": {
        "host": "127.0.0.1",
        "port": 5901,
        "novncUrl": "http://127.0.0.1:6080/vnc.html"
      }
    }
  }
}
```

Resulting `endpoint.json`:

```json
{
  "appId": "dev.byeongsu.tauri-agent.fixture",
  "pid": 4242,
  "transport": "tcp",
  "host": "127.0.0.1",
  "port": 45127,
  "token": "a1b2c3…",
  "vnc": { "host": "127.0.0.1", "port": 5901, "novncUrl": "http://127.0.0.1:6080/vnc.html" }
}
```

The inline server binds a loopback socket that any local process can reach, so
it authenticates every request with a per-session `token`. The plugin generates
the token, publishes it in the app's `endpoint.json` (written `0600` on Unix),
and requires it on each request. The CLI and MCP wrappers read it during
endpoint discovery automatically; a client dialing a known `--port`/`--host`
daemon directly sends no token.

Discover it from the CLI:

```bash
tauri-agent vnc --app dev.byeongsu.tauri-agent.fixture
```

The `vnc` block requires the inline server (the endpoint registry is only
published when the inline server runs). Advertising is discovery-only: the
plugin never binds the VNC port.

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
- `agent_window`
- `agent_wait`
- `agent_state`
- `agent_record`
- `agent_stream`

## Security Direction

Default posture is dev-only and local-only. The live bridge uses explicit Tauri permissions, binds loopback sockets only, and keeps webview actions scoped to the app.

- **Loopback only.** The inline server binds a loopback host by default; a non-loopback host (e.g. `0.0.0.0`) is rejected unless the explicit `allowNonLoopback` plugin config opt-in is set.
- **Release gating.** The inline server runs in debug builds when enabled, but release builds require the explicit `allowReleaseSocket` opt-in before binding a debugger socket.
- **`eval` is not in `agent:default`.** `eval` is arbitrary in-webview code execution, so it is excluded from the `agent:default` permission set and must be granted explicitly with `agent:allow-agent-eval`. A non-mutating `agent:readonly` set is provided for cautious adopters.
- **Unforgeable bridge ids.** Bridge request ids carry a random suffix so one webview cannot spoof another window's bridge response.
- **App-scoped native surfaces.** Native screenshots are explicit through `backend: "native"` or `backend: "auto"` and remain app-window scoped. Native input remains a separate fallback path and should not become arbitrary system UI control without a deliberate opt-in.
