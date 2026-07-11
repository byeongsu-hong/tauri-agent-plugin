# Adopting tauri-agent

How to wire the plugin into your own Tauri v2 app so agents (and the CLI/MCP)
can drive it.

## Quickstart

1. **Add the crate** to `src-tauri/Cargo.toml` and register the plugin:

   Wry is the default. CEF apps disable it and select the CEF feature while the
   app supplies its concrete CEF runtime:

   ```toml
   tauri-agent-plugin = { version = "0.0.2", default-features = false, features = ["cef"] }
   ```

   ```rust
   tauri::Builder::default()
     .plugin(tauri_agent_plugin::init())
     .run(tauri::generate_context!())?;
   ```

2. **Grant the permission** in `src-tauri/capabilities/*.json`. Without this,
   every `plugin:agent|*` invoke fails with a permissions error:

   ```json
   { "permissions": ["core:default", "agent:default"] }
   ```

   Use `agent:readonly` for a non-mutating subset, and add
   `agent:allow-agent-eval` only if you need `eval`. See
   [security.md](./security.md) for the full permission model.

3. **Install the guest instrumentation** in your frontend. Bridge commands
   (`tree`, `click`, …) hang until the webview calls `install()`:

   ```ts
   import { WebviewAgentInstrumentation } from '@byeongsu-hong/tauri-agent-plugin'
   new WebviewAgentInstrumentation({ windowLabel: 'main' }).install()
   ```

4. **Enable the inline server** if you want out-of-process control via the
   CLI/MCP (see below).

5. **Verify the wiring** — the adopter's first smoke test:

   ```bash
   tauri-agent attach --app <your.app.identifier>
   ```

## Enable the inline server

Add an `inlineServer` block to `tauri.conf.json`. `port: 0` picks an ephemeral
loopback port; `publishEndpoint` writes the app-scoped `endpoint.json` registry
the CLI/MCP discover by app id:

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

The server binds loopback only and authenticates every request with a
per-session token published in the registry — see [security.md](./security.md).

## Advertise a VNC surface (optional)

For a human/QA view, the plugin can advertise where a VNC/noVNC stream lives (it
never runs the VNC server itself). Add a `vnc` block; it is published into
`endpoint.json` alongside the debugger transport so a fleet viewer discovers
both by app id:

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

Discover it with `tauri-agent vnc --app <id>`. See
[architecture.md](./architecture.md#two-surfaces) for the surface model.

## Guest instrumentation

`WebviewAgentInstrumentation` runs in your webview and answers the bridge. It
also exposes the same operations directly for in-process use:

```ts
import { WebviewAgentInstrumentation } from '@byeongsu-hong/tauri-agent-plugin'

const agent = new WebviewAgentInstrumentation({
  windowLabel: 'main',
  state: { route: () => location.pathname }
})

agent.install()
agent.snapshot()
agent.find({ role: 'button', name: 'Forge', limit: 1 })
await agent.act({ role: 'button', name: 'Forge', action: 'click' })
```

The `agent<Method>` helpers (`agentSnapshot`, `agentFind`, …) call the same Rust
commands from app code; see [commands.md](./commands.md) for the full surface.

## Fixture app

`examples/fixture-app` is a minimal Bun + TypeScript + Tauri v2 app wired to this
plugin by local path. It is the first real target for live-bridge work — its
config enables the inline server, it opens `main` and `secondary` windows for
`--window` testing, and its UI exposes agent-testable semantics.

**Fresh-clone build order.** The fixture imports the root package's gitignored
`dist-js` output directly, so build the repo root first:

```bash
# from the repo root
bun install
bun run build            # produces dist-js for the fixture
cd examples/fixture-app
bun install
bun run tauri:dev
```

The fixture also ships a headless `--self-test` mode used in CI — see
`examples/fixture-app/README.md`.
