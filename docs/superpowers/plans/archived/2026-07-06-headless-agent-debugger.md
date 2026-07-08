# Headless Agent Debugger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `tauri-agent` from a compact-tree scaffold into a headless agent debugger spine for Tauri apps.

**Architecture:** The product is a protocol-first debugger made of a TypeScript JSON-RPC client/server, a Bun CLI, guest webview instrumentation, and a Tauri plugin bridge. The first durable milestone is a testable headless session that supports attach, windows, tree, click, fill, press, screenshot placeholder, logs, events, wait, state, and record without relying on static CLI-only behavior.

**Tech Stack:** Bun, TypeScript, Vitest, Commander, JSDOM for deterministic headless bridge tests, Tauri v2 Rust plugin models/commands.

---

## File Structure

- `protocol/types.ts`: shared command, response, event, window, log, screenshot, wait, and recording types.
- `protocol/json-rpc.ts`: JSON-RPC request/response helpers and validation.
- `daemon/session.ts`: in-memory debugger session model for windows, refs, logs, events, state, and recordings.
- `daemon/server.ts`: line-delimited JSON-RPC server over Node/Bun sockets.
- `daemon/client.ts`: client for CLI and future MCP wrappers.
- `daemon/static-app.ts`: static HTML-backed app adapter used by tests and local CLI prototyping.
- `guest-js/instrumentation.ts`: webview instrumentation for semantic tree, actions, logs, events, waiters, state probes, and recordings.
- `bin/tauri-agent.ts`: CLI commands backed by the protocol client, with `--from-html` as an attachable static adapter.
- `src/models.rs`, `src/commands.rs`: Rust-side protocol-shaped models and bridge command names.
- `tests/*.test.ts`: TDD coverage for protocol, daemon session, CLI smoke, and guest instrumentation.

## Tasks

### Task 1: Protocol Contract

**Files:**
- Create: `protocol/types.ts`
- Create: `protocol/json-rpc.ts`
- Test: `tests/protocol.test.ts`

- [ ] Write failing tests proving request ids, success responses, error responses, and method names for `attach`, `windows`, `tree`, `click`, `fill`, `press`, `shot`, `logs`, `events`, `wait`, `state`, and `record`.
- [ ] Run `bun run test tests/protocol.test.ts` and verify it fails because `protocol/json-rpc.ts` does not exist.
- [ ] Implement typed JSON-RPC helpers and method constants.
- [ ] Run `bun run test tests/protocol.test.ts` and verify it passes.

### Task 2: Headless Session Core

**Files:**
- Create: `daemon/session.ts`
- Create: `daemon/static-app.ts`
- Test: `tests/session.test.ts`

- [ ] Write failing tests proving a static HTML app can attach, list a `main` window, return a semantic tree, perform click/fill/press by `@ref`, collect logs/events, return state, wait for text, and record actions.
- [ ] Run `bun run test tests/session.test.ts` and verify it fails because the session modules do not exist.
- [ ] Implement `DebuggerSession` and `StaticHtmlAppAdapter` using the existing semantic tree/action helpers.
- [ ] Run `bun run test tests/session.test.ts` and verify it passes.

### Task 3: JSON-RPC Server and Client

**Files:**
- Create: `daemon/server.ts`
- Create: `daemon/client.ts`
- Test: `tests/daemon-rpc.test.ts`

- [ ] Write failing tests proving a client can call the server over an in-process duplex transport and receive `windows`, `tree`, `fill`, and `state` results.
- [ ] Run `bun run test tests/daemon-rpc.test.ts` and verify it fails because server/client modules do not exist.
- [ ] Implement transport-independent request handling first, then a line-delimited socket wrapper.
- [ ] Run `bun run test tests/daemon-rpc.test.ts` and verify it passes.

### Task 4: CLI Uses Protocol

**Files:**
- Modify: `bin/tauri-agent.ts`
- Test: `tests/cli.test.ts`

- [ ] Write failing tests or smoke helpers proving `tree --from-html`, `windows --from-html`, `fill --from-html`, `logs --from-html`, `events --from-html`, `wait --from-html`, `state --from-html`, and `record --from-html` route through the session/protocol path.
- [ ] Run the focused CLI test and verify it fails on missing commands.
- [ ] Replace direct static-only command handlers with protocol/session-backed handlers.
- [ ] Run the focused CLI test and verify it passes.

### Task 5: Guest Instrumentation

**Files:**
- Create: `guest-js/instrumentation.ts`
- Modify: `guest-js/index.ts`
- Test: `tests/instrumentation.test.ts`

- [ ] Write failing tests proving instrumentation captures console logs, DOM events, current tree, ref actions, state probes, text waits, and recording entries.
- [ ] Run `bun run test tests/instrumentation.test.ts` and verify it fails because instrumentation does not exist.
- [ ] Implement instrumentation as a small class around the existing semantic-tree helpers.
- [ ] Run `bun run test tests/instrumentation.test.ts` and verify it passes.

### Task 6: Rust Bridge Shape

**Files:**
- Modify: `src/models.rs`
- Modify: `src/commands.rs`
- Modify: `build.rs`

- [ ] Add Rust model coverage through `cargo check` for protocol-shaped methods and placeholders: attach, logs, wait, state, record.
- [ ] Update generated permissions by running `cargo check`.
- [ ] Run `cargo fmt -- --check && cargo check` and verify it passes.

### Task 7: Docs and Verification

**Files:**
- Modify: `README.md`

- [ ] Update README from v0 scaffold language to headless debugger language.
- [ ] Run `bun run check`.
- [ ] Run `cargo fmt -- --check && cargo check`.
- [ ] Run CLI smoke for `tree`, `windows`, `fill`, `state`, and `record` against static HTML.
- [ ] Commit and push the feature branch.
