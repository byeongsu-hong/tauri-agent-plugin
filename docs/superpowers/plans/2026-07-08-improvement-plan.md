# tauri-agent Improvement Plan

**Date:** 2026-07-08
**Status:** Proposed
**Supersedes:** `2026-07-06-headless-agent-debugger.md` (fully implemented; archive it)

## Current State

The headless-debugger spine works end to end: 26 protocol methods across CLI, MCP, daemon, guest instrumentation, and the Rust inline server, with a green check suite (`bun run check` passes, `cargo fmt` clean, 16 TS test files + 28 Rust tests). But a full audit (three parallel deep reviews: Rust plugin, TypeScript side, DX/packaging) found the project is **not safe to point at real apps in shared environments, not correct under DOM mutation, and not publishable** — plus substantial duplication that will tax every future feature.

This plan is organized into seven workstreams, ordered by priority. Within each workstream, items are ordered by impact.

---

## WS1 — Security hardening (P0: do first)

The stated posture (README "Security Direction") is dev-only, local-only, permission-gated. The implementation doesn't yet enforce it.

1. **Authenticate the inline server.** The TCP socket answers any connection with no token or handshake (`src/server.rs:141`, `src/server.rs:226-249`), and `eval` routes straight through `bridge_call` (`src/server.rs:112-115`) — any local process (any user, since loopback is not user-scoped) gets arbitrary JS execution in the webview. Generate a per-session token, publish it in the endpoint descriptor with `0600` file permissions, and require it on every request. Update `daemon/endpoint.ts` + CLI/MCP discovery to send it.
2. **Enforce loopback binding.** Nothing rejects `"host": "0.0.0.0"` (`src/models.rs:19-20` → `src/server.rs:141`); combined with `allowReleaseSocket` (`src/lib.rs:64-71`) a misconfigured release build exposes unauthenticated remote eval. Validate `is_loopback()` unless a second explicit `allowNonLoopback` opt-in is set.
3. **Split `eval` out of the default permission set.** `permissions/default.toml:12` ships `allow-agent-eval` in `default`, contradicting README:358. Add a `default` without eval plus explicit `allow-agent-eval` opt-in; consider a `readonly` set (tree/find/inspect/logs/events/state/shot) for cautious adopters.
4. **Unforgeable bridge responses.** Bridge ids are sequential `bridge-{n}` (`src/bridge.rs:51`) and `agent_bridge_response` (`src/commands.rs:20-27`) is invocable by any permitted webview — one window can forge responses for another. Use random UUIDs and verify the responding window label matches the request target.
5. **Fix `safe_app_id` path escape.** `".."` survives sanitization (`src/endpoint.rs:141-152`), letting a crafted `--app` escape the registry directory. Reject dot-only ids. Add tests (currently zero coverage).

## WS2 — Correctness & robustness (P0/P1)

### TypeScript

1. **Snapshot epochs + liveness for refs (P0).** One module-global `currentRefs` is replaced by every snapshot (`guest-js/semantic-tree.ts:34`, `:273-279`), and `find`/`wait` snapshot internally (`guest-js/instrumentation.ts:137-140`) — so `tree → find → click @5` can click a *different element with no error*. MCP re-runs `tree` before every ref action (`mcp/server.ts:111-139`), reinterpreting old refs against fresh snapshots. Stamp snapshots with an epoch (e.g. `@s2e5`), reject stale-epoch refs with a distinct error code, and check `element.isConnected` in `resolveRef` (`guest-js/semantic-tree.ts:88-95`). This fixes the whole wrong-element bug class at once.
2. **Capture `console.log` (P0).** The install loop covers only `debug|info|warn|error` (`guest-js/instrumentation.ts:68`, `:102`). Also serialize object args properly instead of `[object Object]` (`:105`).
3. **Daemon/socket resilience (P0/P1).** `handleLineSocket` has no `socket.on('error')` — a client reset kills the daemon (`daemon/server.ts:48-61`). `SocketTransport.send` can hang forever with no timeout or `close` handler (`daemon/client.ts:90-114`). Line buffers grow unboundedly without a newline (`daemon/server.ts`, `mcp/stdio.ts:8-14`, `daemon/client.ts:99`). Add error handlers, connect/response timeouts, and max line length.
4. **Bound capture buffers (P1).** `capturedLogs/Events/Network/recordingEntries` have no cap (`guest-js/instrumentation.ts:80-84`); long-lived apps leak. Use ring buffers. Also stop cloning + fully reading every fetch response body just to measure size (`:723-730`) — prefer `content-length`.
5. **Sequence-id follow diffing (P1).** Length-based diffing (`mcp/server.ts:193-195`, `bin/tauri-agent.ts:564`) duplicates or drops entries after clears. Give `LogEntry`/`AgentEvent` monotonic ids (as `NetworkEntry` already has) and diff on those. Remove or implement the dead `LogsParams.follow` protocol field.
6. **Unblock MCP stdio queue (P1).** Strictly sequential dispatch (`mcp/stdio.ts:19`) means one long `tauri_wait` blocks every subsequent MCP request. Run long-poll tools concurrently or cap their timeouts.
7. **Smaller fixes:** error class with `.code` instead of string-prefix matching (`daemon/client.ts:17`, `daemon/server.ts:78-87`); typed param validation that errors on mismatch instead of silently defaulting (`daemon/session.ts:162-172`); static `state()` reads constructor-time title (`daemon/static-app.ts:318`); `wait` busy-polls at ≤10ms with full snapshots — use MutationObserver or backoff (`guest-js/instrumentation.ts:258-268`); bridge `dispose()` race leaks the listener (`guest-js/instrumentation.ts:386-392`).

### Rust

1. **Cap bridge timeouts, fix pending leak, stop blocking tokio workers (P1).** `timeoutMs` is client-controlled and uncapped — `u64::MAX` parks a worker thread forever (`src/bridge.rs:65`, `:114-127`). `insert_pending` before a fallible `emit_to` leaks the pending entry on error (`src/bridge.rs:52-63`). Cap timeouts (~60s), remove pending on emit failure, and consider a oneshot-`.await` bridge so async commands don't block runtime threads.
2. **Bound the TCP surface (P1).** Detached per-connection threads with no cap, no read timeout, no shutdown propagation, and unbounded line buffering (`src/server.rs:214-216`, `:226-249`, `:234`). Add idle read timeout, max line length, a connection cap, and join on shutdown.
3. **Endpoint registry lifecycle (P1).** Registry is deleted on vetoable `ExitRequested` (`src/lib.rs:101-110`), deleted even when this instance didn't publish (`src/lib.rs:47-51`), clobbered by a second instance, and written non-atomically (`src/endpoint.rs:95`). Clean up only on `Exit`/`Drop`, track did-publish, write tmp+rename, and consider pid-scoped names.
4. **Honest error taxonomy (P1).** Everything collapses to `BRIDGE_UNAVAILABLE` (`src/error.rs:4-13`, `src/server.rs:349-356`) — misleading for agents deciding whether to retry. Add `InvalidParams`/`Timeout`/`Io`/`UnsupportedPlatform` variants and stop discarding serde detail. Also: malformed ref ≠ `StaleRef`, and `press` skips ref validation (`src/commands.rs:67-77`).
5. **Unify default-window selection (P1).** Two divergent copies fall back to the alphabetically-first label — an app with `about` + `main` silently targets `about` (`src/bridge.rs:129-148` vs `src/commands.rs:421-437`). One helper: prefer `main`, then focused, then first.

## WS3 — Release readiness (P0 before any publish)

1. **Real license texts.** `LICENSE` is an 18-byte SPDX string — legally the project is unlicensed. Add full `LICENSE-MIT` + `LICENSE-APACHE`, referenced from `package.json` and `Cargo.toml`.
2. **CI.** No `.github/` at all. Add a workflow: `bun run check` + `cargo fmt --check` + `cargo clippy -D warnings` + `cargo test` on an ubuntu/macos/windows matrix (Linux needs `libwebkit2gtk-4.1-dev`), plus an `npm pack` + install-from-tarball smoke test. The macOS-only `cfg` code (`src/screenshot.rs`) is exactly what breaks silently without this — clippy already shows 3 dead-code warnings on Linux (`NATIVE_SCREENSHOT_TIMEOUT`, `native_screenshot_result_from_png_bytes`, `png_dimensions` need cfg-gating).
3. **Publishable packaging.** `files` lists gitignored `dist-js`/`dist-cli` with no `prepublishOnly` — publishing from a clean checkout ships a package whose `main`/`bin` point at nothing. Add `prepublishOnly: "bun run check"`, `publishConfig.access: public`, `engines`, `sideEffects: false`. Cargo side: add `keywords`, `categories`, `readme`, and an `include` list (currently `cargo publish` would package the whole repo including the fixture app). Verify crate-name availability.
4. **Versioning.** No tags, no CHANGELOG, two independent `0.1.0`s. Adopt covector (what tauri-plugins-workspace uses) or a tag-triggered release workflow keeping npm + crates.io in lockstep.
5. **Demote `jsdom`.** It's a production dependency but only the `--from-html` static adapter uses it — every adopter drags in its tree. Dynamic `import()` or a separate CLI package.
6. **Gate Rust tests.** `cargo test` is in no check script and no documented flow — 28 tests run only when someone remembers.

## WS4 — Structure & duplication (P1/P2)

1. **Extract shared DOM actions.** ~500 lines duplicated verbatim between `guest-js/instrumentation.ts` and `daemon/static-app.ts` (storage/cookie/location/wait/state helpers; `instrumentation.ts:785-986` vs `static-app.ts:479-762`) — and they've already drifted (state probes, log `window` field, press event shape). Extract `guest-js/dom-actions.ts`; the dependency direction already exists.
2. **Canonicalize protocol params.** `fill` accepts `text` or `value` depending on surface; `press` takes `key` or `value`; press event shapes differ; the daemon recording whitelist omits `select`/`check` that the guest captures (`daemon/session.ts:144`). Define one canonical param set in `protocol/types.ts` and make all executors conform — recordings become replayable across surfaces.
3. **Share CLI/MCP connection + follow logic.** `debuggerClient()` (`bin/tauri-agent.ts:693-717`) ≈ `mcp/server.ts:204-230`; `isProcessAlive` and the follow-poll loop are duplicated too. Move into `daemon/client.ts`.
4. **Factor the CLI.** 5 connection options re-declared ~25×, ten identical "tree then action" command bodies (`bin/tauri-agent.ts:184-347`). A `withConnectionOptions` + `refCommand` factory halves the file.
5. **Rust test monoliths.** ~865 lines of `server.rs` tests with 14 near-identical fake backends → one parameterized `ScriptedBackend`; split the single 500-line models mega-test per model.
6. **Single source for the method list.** The bridge whitelist exists in `src/server.rs:112-114`, `src/commands.rs`, `build.rs`, `permissions/default.toml`, and the README — one `const BRIDGE_METHODS` with a consistency test.
7. **Unify screenshot dispatch** between command and server paths (`src/commands.rs:183-201` vs `src/server.rs:280-320`); attach the swallowed native error as context when `auto` falls back and DOM also fails.

## WS5 — DX & docs (P1)

1. **Fix the missing adopter step.** The README never says to add `agent:default` to `src-tauri/capabilities/*.json` (only the fixture does it) — without it every invoke fails. It also never states that bridge commands hang unless the frontend calls `agent.install()`. These belong in step 1 of a quickstart.
2. **Restructure the README.** Line 16 is one ~2,600-character paragraph describing 20 commands. Split: short README (what + 5-step quickstart + links) → `docs/adopting.md` (app developers) → `docs/commands.md` (per-command reference table: CLI form / MCP tool / bridge behavior) → `docs/architecture.md` + `docs/security.md`. Link `permissions/autogenerated/reference.md`. Rewrite the aspirational "should…" endpoint-policy section as fact.
3. **Fresh-clone fixture friction.** The fixture depends on `file:../..` but `dist-js` is gitignored — document (or hook) "build the repo root first."
4. **Document the smoke test** (`tauri-agent attach --app <id>`) as the adopter's first verification.
5. **Housekeeping:** real content or deletion for `AGENTS.md` (currently an internal marker comment); archive the completed 2026-07-06 plan; add JSDoc to `guest-js/index.ts` exports; fix README Package Exports omitting `agentAction`/`agentScreenshot`; label the unix transport "reserved" (modeled in TS, never bound in Rust).

## WS6 — Testing (P1, woven through the above)

1. **Cheapest real e2e:** a fixture `--self-test` autorun mode that runs the existing bridge self-test on boot and exits with a code (today it's a button click producing a human-readable string). Then a full external e2e: build fixture, launch under xvfb on Linux CI, poll for `endpoint.json`, drive `attach/tree/find/click/fill/wait/state` + `--window secondary` via `DebuggerClient`, kill, assert endpoint cleanup. Nothing today ever touches a real webview — every DOM behavior is jsdom, which diverges from WKWebView/webkit2gtk exactly where hover/drag/focus synthesis matters.
2. **Rust integration tests** with `tauri::test::mock_app()`: window collection/control, bridge timeout removes pending entry, emit-failure leak, concurrent completes, server shutdown with live clients, oversized lines.
3. **Regression tests for each WS1/WS2 fix:** ref staleness ("tree → DOM mutates → click"), `console.log` capture, socket error/hang, follow clear-then-regrow, `safe_app_id` `".."`.
4. **Cross-language golden fixtures** for endpoint path/sanitization parity (`src/endpoint.rs` vs `daemon/endpoint.ts` are dual implementations that must not drift).
5. **Parity tests** asserting guest vs static executors return identical shapes (would have caught the press/recording drift).

## WS7 — Capability roadmap (feature work, after WS1–WS4)

Ordered by value to agents driving real Tauri apps:

1. **Tauri IPC invoke tracing** — network capture deliberately skips `ipc://localhost/` (`guest-js/instrumentation.ts:540-542`); for a *Tauri* debugger, observing command/plugin invokes is arguably the flagship feature. Wrap `__TAURI_INTERNALS__.invoke`, expose `tauri_ipc`.
2. **MCP polish** — return screenshots as MCP image content blocks instead of base64-in-JSON-text (`mcp/server.ts:88-91`); per-tool descriptions instead of shared wrong ones (`key` on press/storage/state alike); `readOnlyHint`/`destructiveHint` annotations; server `instructions` teaching the ref workflow; validate required args as `-32602`; decide `html` session persistence (per-call adapters silently reset state between calls).
3. **Realistic input:** `type` (per-keystroke sequences with `input` events — `fill` sets `.value` directly today); file upload; dialog handling (`alert/confirm/prompt` currently block the app unrecoverably).
4. **Waiters:** wait-for-disappear, wait-for-function, network-idle.
5. **`tauri_expect` assertions** (role/name/state/value) to collapse tree→inspect→compare round trips.
6. **Navigation** (back/forward/reload) beyond SPA push/replace; element-scoped screenshots; XHR/WebSocket capture; multi-webview-per-window addressing.
7. **Platform matrix:** Windows (`PrintWindow`/DXGI) and Linux native screenshot backends, or at minimum a distinct `UNSUPPORTED_PLATFORM` error and a documented support matrix. Decide implement-or-delete for the dead `mode: verbose` tree option (advertised on every surface, read by none — `guest-js/semantic-tree.ts:5`).
8. **Async `eval`:** await thenables (Playwright semantics) and document the CSP `unsafe-eval` requirement (`guest-js/instrumentation.ts:244-246`).

---

## Suggested sequencing

| Phase | Content | Rationale |
|-------|---------|-----------|
| 1 | WS1 (security) + WS2 TS items 1–3 + WS3 items 1–2 (license, CI) | Unsafe-by-default, wrong-element bugs, and daemon crashes are disqualifying; CI locks in every fix after it |
| 2 | Rest of WS2 + WS3 (publishable) + WS6 items 1–3 | Correct, releasable, and regression-protected |
| 3 | WS4 (structure) + WS5 (docs) | Dedup before features so every new capability is written once, not three times |
| 4 | WS7 in listed order | Feature growth on a sound base |

Each phase should land as its own reviewed branch series; WS1 items 1–2 change the endpoint descriptor format and should ship together (token + loopback enforcement) as one coherent protocol bump.
