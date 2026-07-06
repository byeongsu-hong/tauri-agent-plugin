# Tauri Agent Fixture App

Minimal Tauri v2 app for testing `tauri-agent`.

```bash
bun install
bun run tauri:dev
```

The UI intentionally exposes stable semantic controls that match the debugger blueprint: navitems, an agent-name textbox, a disabled/enabled register button, and a roster list. The built-in bridge self-test exercises semantic ref finding before driving controls.
