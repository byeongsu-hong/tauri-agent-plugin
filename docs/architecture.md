# Architecture

`tauri-agent` is a protocol-first control surface: one JSON-RPC 2.0 method set,
reachable from several transports, all routing into a single request/response
bridge inside the instrumented webview.

## Components

- **Agent Debug Protocol** (`protocol/`) — the JSON-RPC 2.0 command surface and
  shared types. See [commands.md](./commands.md) for every method.
- **Guest instrumentation** (`guest-js/`) — runs in the app webview: semantic
  tree snapshots, `@ref` finding/inspection/actions, input synthesis, console /
  error / network (fetch/XHR/WebSocket) / IPC capture, storage/cookie/location
  access, dialogs, waiters, and action recording.
- **Tauri plugin** (`src/`, Rust) — the opt-in inline loopback server, the
  app-scoped endpoint registry, Tauri permissions, window discovery/control,
  native screenshots, and the bridge into instrumented webviews.
- **Daemon / client** (`daemon/`) — in-process and TCP line-delimited transports,
  a static jsdom adapter for deterministic prototyping, and the shared
  connection/follow logic (`daemon/connect.ts`).
- **MCP server** (`mcp/`) — a stdio Model Context Protocol wrapper exposing the
  protocol as `tauri_<method>` tools, with image content for screenshots.
- **CLI** (`bin/tauri-agent.ts`) — agent-facing commands over the same path.

## Request flow

An external caller (CLI/MCP) discovers the app's `endpoint.json` by app id,
dials the loopback socket with the session token, and sends a JSON-RPC line. The
Rust inline server routes `attach`/`windows`/`window`/`shot` natively and every
other method through `bridge_call`, which emits a request event to the target
webview and awaits the guest's `agent_bridge_response`. In-process app code
reaches the same bridge through the `agent_<method>` Tauri commands.

`attach` is also capability negotiation: it returns a per-process session id,
platform/runtime, supported methods, screenshot backends, and feature markers.
Consumers use those fields instead of guessing from the selected build variant.

## Transports & endpoint discovery

- No global `/tmp/tauri-mcp.sock`. Each app publishes an app-scoped registry at
  `.../tauri-agent/<app-id>/endpoint.json` under the runtime directory.
- App ids are sanitized identically in Rust (`src/endpoint.rs`) and TS
  (`daemon/endpoint.ts`) — locked by a shared golden fixture
  (`tests/fixtures/endpoint-app-ids.json`) so dot-only ids can't escape the
  runtime directory.
- Localhost TCP is the portable fallback and the current inline-server
  transport; a Unix socket variant is modeled in the descriptor and reserved.
- CLI and MCP discover the endpoint by app id (`--app`), a known daemon
  (`--port`/`--host`), or static HTML (`--from-html` / `html`).

## Two surfaces

`tauri-agent` exposes two surfaces for the same running app:

- **Agent surface (DOM/semantic)** — the committed-DOM semantic tree with
  `@ref` actions (`click @2`, `type @1 "..."`). This is the primary surface,
  served over the inline debugger endpoint. A live push stream of semantic-tree
  diffs is available via `stream`: a `MutationObserver` in the guest drives diff
  frames (no polling loop) and consumers drain them against a monotonic cursor,
  long-polling for the next change. The first line is the full compact tree
  (`{ snapshot, cursor }`); each subsequent line is a change frame
  (`{ seq, added, removed }`).
- **Human surface (VNC/noVNC)** — a visual view for QA. The plugin does not run
  a VNC server; it only **advertises** where the stream lives (in
  `endpoint.json`) so a viewer can discover it. The surrounding harness runs the
  VNC server (e.g. `x11vnc` + `websockify` against the app's virtual display).

## Fleet boundary

`tauri-agent-fleet` imports the published `DebuggerClient` directly; it does not
use MCP. The plugin owns one app session, atomic locator actions, bounded cursor
captures, and compact semantic deltas. Fleet owns builds, isolated processes,
scheduling, models, suites, artifacts, and dashboards. The plugin never depends
on Fleet.

`act` closes the rerender race by locating, waiting, and acting inside one guest
request. Its `traceId` is copied onto synchronous logs/events/network/IPC so an
agent can follow one interaction across surfaces. Capture lists are summaries;
network/IPC `id` lookup exposes bounded, redacted detail. All capture calls use
monotonic `since` cursors, and lean stream
pulls omit the full snapshot after initial synchronization unless frames were
dropped and recovery is required.

## Screenshot backend support matrix

`shot` defaults to a DOM-rendered SVG for deterministic output. Native pixel
capture is platform-specific:

| Platform | `dom` | `native` | `auto` |
| --- | --- | --- | --- |
| macOS | ✅ | ✅ (`NSWindow`) | native → dom |
| Linux | ✅ | ❌ `UNSUPPORTED_PLATFORM` | dom |
| Windows | ✅ | ❌ `UNSUPPORTED_PLATFORM` | dom |

Off macOS, `native` returns a distinct `UNSUPPORTED_PLATFORM` error (so agents
don't retry it as a transient failure); use `dom` or `auto`. Element-scoped
captures (`--ref`) always use the DOM backend.

## Package exports

```ts
import { WebviewAgentInstrumentation, agentSnapshot /* … */ } from '@byeongsu-hong/tauri-agent-plugin'
import { DebuggerClient, SocketTransport } from '@byeongsu-hong/tauri-agent-plugin/daemon'
import { createMcpRequestHandler } from '@byeongsu-hong/tauri-agent-plugin/mcp'
import { AGENT_METHODS } from '@byeongsu-hong/tauri-agent-plugin/protocol'
```

`jsdom` is an optional peer used only by the static `--from-html` adapter;
adopters of the guest/protocol/plugin packages do not install it transitively.

## Multi-webview (opt-in)

By default the plugin addresses one webview per window. Building the crate with
the `unstable-multiwebview` feature (which enables Tauri's `unstable` API) lets
`tree`/`find`/`click`/etc. target a specific child webview by label, and lists
child webviews in `windows`. Single-webview behavior is byte-identical without
the feature.
