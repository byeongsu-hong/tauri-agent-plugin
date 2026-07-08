# Command reference

Every capability is one protocol method reachable four ways: the `tauri-agent`
CLI, an MCP tool (`tauri_<method>`), a guest helper (`agent<Method>` / an
`WebviewAgentInstrumentation` method), and the Rust command (`agent_<method>`).
This table is the single source for what each does.

| Method | CLI | MCP tool | Behavior |
| --- | --- | --- | --- |
| `attach` | `tauri-agent attach` | `tauri_attach` | Confirm the app is reachable and return its windows. |
| `windows` | `tauri-agent windows` | `tauri_windows` | List addressable webview windows (label, title, focus/visibility, bounds). With `unstable-multiwebview`, child webviews appear too. |
| `window` | `tauri-agent window --action <a>` | `tauri_window` | Read or control one window: `get`/`focus`/`show`/`hide`/`minimize`/`unminimize`/`maximize`/`unmaximize`/`setSize`/`setPosition`. |
| `tree` | `tauri-agent tree [--mode verbose] [--scope <sel>] [--interactive]` | `tauri_tree` | Compact semantic tree with `@ref`s. `verbose` adds `value`/`#id`/`[testid]`/`type` annotations on the same lines (refs stay stable). |
| `find` | `tauri-agent find --role <r> --name <n> --text <t> --limit <k>` | `tauri_find` | Refresh the snapshot and return inspect-shaped matches, so agents get refs without parsing tree text. |
| `inspect` | `tauri-agent inspect @<n>` | `tauri_inspect` | Full detail for one ref: role, name, tagName, text, value, attributes, states. |
| `click` | `tauri-agent click @<n>` | `tauri_click` | Click a ref. |
| `hover` | `tauri-agent hover @<n>` | `tauri_hover` | Dispatch `mouseover`/`mouseenter`/`mousemove`. |
| `focus` / `blur` | `tauri-agent focus @<n>` | `tauri_focus` / `tauri_blur` | Move or remove keyboard focus. |
| `scroll` | `tauri-agent scroll @<n> [y] [x]` | `tauri_scroll` | Scroll a ref by `x`/`y` deltas and fire a scroll event. |
| `drag` | `tauri-agent drag @<from> @<to>` | `tauri_drag` | Dispatch a drag sequence from one ref to another. |
| `fill` | `tauri-agent fill @<n> <text>` | `tauri_fill` | Set a control's value in one shot (canonical param `text`). |
| `type` | `tauri-agent type @<n> <text>` | `tauri_type` | Type per-keystroke with keydown/keypress/input/keyup so masking/validation/autocomplete observe realistic input. |
| `select` | `tauri-agent select @<n> <value>` | `tauri_select` | Choose a `<select>` option by value or visible label. |
| `check` | `tauri-agent check @<n> <true\|false>` | `tauri_check` | Set checkbox/radio state idempotently. |
| `upload` | `tauri-agent upload @<n> <name[=text]>...` | `tauri_upload` | Set synthetic files on an `<input type=file>` ref and fire input/change. |
| `press` | `tauri-agent press <key> [--ref @<n>] [--modifier <m>]` | `tauri_press` | Dispatch a key to the active element (or focus a ref first) with `Alt`/`Control`/`Meta`/`Shift`. |
| `eval` | `tauri-agent eval <code>` | `tauri_eval` | Dev-only JS eval; returns `{ type, text, value? }` and awaits thenables. Requires `agent:allow-agent-eval`. |
| `shot` | `tauri-agent shot [path] [--backend <b>] [--ref @<n>]` | `tauri_shot` | Screenshot. `dom` (SVG), `native` (macOS pixels), `auto` (native→dom). `--ref` crops to one element (forces `dom`). |
| `logs` | `tauri-agent logs [--follow] [--clear]` | `tauri_logs` | Captured `console.*` plus uncaught `error`/`unhandledrejection`. |
| `events` | `tauri-agent events [--follow] [--clear]` | `tauri_events` | Captured lifecycle/interaction events. |
| `network` | `tauri-agent network [--follow] [--clear]` | `tauri_network` | Captured fetch/XHR/WebSocket entries (method, url, status, timing, sizes). WebSocket carries `101` on open. |
| `ipc` | `tauri-agent ipc [--follow] [--clear]` | `tauri_ipc` | Captured Tauri IPC invokes (command, timing, ok/error). Skips the agent's own bridge traffic. |
| `storage` | `tauri-agent storage --action <a> --key <k> --value <v> [--area session]` | `tauri_storage` | Read/mutate localStorage/sessionStorage. |
| `cookies` | `tauri-agent cookies --action <a> --name <n> --value <v>` | `tauri_cookies` | Read/mutate webview-visible `document.cookie`. |
| `location` | `tauri-agent location --action <a> --url <u>` | `tauri_location` | Read location or navigate: `push`/`replace`/`reload`/`back`/`forward`. |
| `wait` | `tauri-agent wait [text] [--role/--name] [--absent] [--fn <expr>] [--network-idle]` | `tauri_wait` | Wait for text/a semantic target to appear (or disappear with `--absent`), a JS predicate to be truthy (`--fn`), or the network to go idle (`--network-idle`). |
| `expect` | `tauri-agent expect --role/--name/--text [--absent] [--value] [--has-state]` | `tauri_expect` | Assert presence/absence, value, or a state flag in one round trip; errors on mismatch. |
| `dialog` | `tauri-agent dialog [get\|set\|clear] [--accept/--no-accept] [--prompt-text]` | `tauri_dialog` | Auto-handle `alert`/`confirm`/`prompt` (they otherwise block). Set the policy up front, then read what fired. |
| `state` | `tauri-agent state [--key <field>]` | `tauri_state` | Read the app's exposed state probes; `--key` returns one field. |
| `record` | `tauri-agent record --action <a>` | `tauri_record` | Control action recording (`start`/`stop`/`get`/`clear`). Recorded params are canonical, so recordings replay across surfaces. |
| `stream` | `tauri-agent stream [--since <c>] [--wait-ms] [--timeout-ms]` | `tauri_stream` | Long-poll the mutation-driven semantic diff stream from a cursor. |

## Notes

- **Follow polling.** `logs`/`events`/`network`/`ipc` accept `--follow`
  (`follow`), `--poll-ms`, and `--timeout-ms`. The CLI streams newline-delimited
  JSON forever (or until the timeout); MCP returns one bounded accumulated
  result so agent calls stay finite.
- **Connection inputs.** Every command accepts `--app <id>` (endpoint
  discovery), `--port`/`--host` (a known daemon), or `--from-html <path>` /
  `html` (deterministic static prototyping). Targeting a specific window uses
  `--window <label>`.
- **Canonical params.** `fill`/`type` take `text`, `press` takes `key`,
  `select` takes `value`, `check` takes `checked`. The guest also accepts a
  legacy `value` alias for `fill`/`press`, but every first-party surface and all
  recordings emit the canonical names.
