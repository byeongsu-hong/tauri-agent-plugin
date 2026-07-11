# Tauri Agent Fixture App

Minimal Tauri v2 app for testing `tauri-agent`.

```bash
bun install
bun run tauri:dev
```

The UI intentionally exposes stable semantic controls that match the debugger blueprint: navitems, an agent-name textbox, a disabled/enabled register button, and a roster list. The built-in bridge self-test exercises semantic ref finding before driving controls.

## Headless self-test (CI)

Launching the built app with `TAURI_AGENT_SELF_TEST=1` runs the in-webview
bridge self-test on boot and exits with a code — `0` pass, `1` fail, `2`
timeout. This is the cheapest real end-to-end check that a live
WKWebView/webkit2gtk webview (not jsdom) answers the agent bridge.

```bash
# from the repo root
bun run build                       # build the plugin JS the fixture imports
cd examples/fixture-app
bun install
bun run tauri:build -- --no-bundle  # produce the binary
TAURI_AGENT_SELF_TEST=1 xvfb-run -a src-tauri/target/release/tauri-agent-fixture
```

CI runs this in the `e2e` job, then launches the fixture again and runs
`tests/live-fixture.ts`. That second pass discovers the published authenticated
endpoint and drives both windows through the built CLI, including correlated
diagnosis and network/IPC detail redaction.
