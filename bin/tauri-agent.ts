#!/usr/bin/env node
import { readFile } from 'node:fs/promises'

import { Command } from 'commander'

import type { DebuggerClient } from '../daemon/client'
import { collectDiagnosis, connectDebuggerClient, pollFollow } from '../daemon/connect'
import { readEndpointRegistry } from '../daemon/endpoint'
import { createDebuggerRpcHandler, createLineJsonRpcServer } from '../daemon/server'
import { DebuggerSession } from '../daemon/session'
import { StaticHtmlAppAdapter } from '../daemon/static-app'
import { isRecordableMethod } from '../protocol/json-rpc'
import type { AgentMethod, KeyModifier, LocatorAction, ScreenshotBackend, StreamResult, WindowAction } from '../protocol/types'

interface ConnectionOptions {
  app?: string
  fromHtml?: string
  mode?: 'compact' | 'verbose'
  scope?: string
  window?: string
  host?: string
  port?: number
}

interface FollowOptions extends ConnectionOptions {
  follow?: boolean
  clear?: boolean
  pollMs?: number
  timeoutMs?: number
  since?: number
  limit?: number
  id?: string
}

interface TreeOptions extends ConnectionOptions {
  interactive?: boolean
  pollMs?: number
  timeoutMs?: number
}

interface StreamOptions extends ConnectionOptions {
  since?: number
  waitMs?: number
  timeoutMs?: number
}

interface FindOptions extends ConnectionOptions {
  role?: string
  name?: string
  text?: string
  limit?: number
}

interface ActOptions extends FindOptions {
  value?: string
  x?: number
  y?: number
  timeoutMs?: number
  detail?: boolean
}

interface StorageOptions extends ConnectionOptions {
  area?: 'local' | 'session'
  action?: 'get' | 'set' | 'remove' | 'clear'
  key?: string
  value?: string
}

interface CookieOptions extends ConnectionOptions {
  action?: 'get' | 'set' | 'remove' | 'clear'
  name?: string
  value?: string
}

interface LocationOptions extends ConnectionOptions {
  action?: 'get' | 'push' | 'replace' | 'reload' | 'back' | 'forward'
  url?: string
}

interface WindowOptions extends ConnectionOptions {
  action?: WindowAction
  x?: number
  y?: number
  width?: number
  height?: number
}

interface PressOptions extends ConnectionOptions {
  ref?: string
  modifier?: KeyModifier[]
}

interface WaitOptions extends ConnectionOptions {
  role?: string
  name?: string
  timeoutMs?: number
  absent?: boolean
  fn?: string
  networkIdle?: boolean
  idleMs?: number
}

interface ExpectOptions extends ConnectionOptions {
  role?: string
  name?: string
  text?: string
  absent?: boolean
  value?: string
  hasState?: string
}

interface StateOptions extends ConnectionOptions {
  key?: string
}

interface DialogOptions extends ConnectionOptions {
  accept?: boolean
  promptText?: string
}

interface ShotOptions extends ConnectionOptions {
  backend?: ScreenshotBackend
  ref?: string
}

/**
 * Attach the connection options shared by every command (`--app`,
 * `--from-html`, `--host`, `--port`, `--window`, and optionally `--scope`) so
 * they are declared once instead of ~25 times.
 */
function withConnectionOptions(command: Command, options: { scope?: boolean } = {}): Command {
  command
    .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
    .option('--from-html <path>', 'prototype against a static HTML file')
    .option('--host <host>', 'debug daemon host', '127.0.0.1')
    .option('--port <port>', 'debug daemon port', Number)
    .option('--window <label>', 'Tauri window label')
  if (options.scope) {
    command.option('--scope <selector>', 'limit the snapshot ref refresh to a CSS selector')
  }
  return command
}

/**
 * Register a ref command whose whole body is "refresh the tree, then run one
 * ref action" — the shape shared by click/hover/focus/blur/inspect.
 */
function registerSimpleRefCommand(name: AgentMethod, description: string, argDescription: string): void {
  withConnectionOptions(
    program.command(name).description(description).argument('<ref>', argDescription),
    { scope: true }
  ).action(async (ref: string, options: ConnectionOptions) => {
    const client = await debuggerClient(options)
    await client.call('tree', treeParams(options))
    printJson(await client.call(name, refActionParams(options, ref)))
  })
}

/**
 * Register a capture command with the shared `--follow`/`--clear`/`--poll-ms`/
 * `--timeout-ms` surface — the shape shared by logs/events/network/ipc.
 */
function registerFollowCommand(
  name: 'logs' | 'events' | 'network' | 'ipc',
  description: string,
  noun: string
): void {
  const command = withConnectionOptions(program.command(name).description(description))
    .option('--follow', `poll and stream new ${noun} entries as newline-delimited JSON`)
    .option('--clear', `clear captured ${noun} entries after reading`)
    .option('--poll-ms <ms>', 'follow polling interval in milliseconds', parseNumber, 250)
    .option('--timeout-ms <ms>', 'stop following after this many milliseconds', parseNumber)
    .option('--since <cursor>', 'return entries after this cursor', parseNumber)
    .option('--limit <count>', 'maximum entries to return', parseNumber)
  if (name === 'network' || name === 'ipc') {
    command.option('--id <id>', `return one retained ${noun} detail by id`)
  }
  command.action(async (options: FollowOptions) => {
      if (options.follow) {
        await followEntries(options, name)
        return
      }
      printJson(
        await call(options, name, {
          ...targetParams(options),
          clear: options.clear,
          since: options.since,
          limit: options.limit,
          id: options.id
        })
      )
    })
}

const program = new Command()

program
  .name('tauri-agent')
  .description('Headless agent debugger for Tauri apps.')
  .version('0.1.0')

program
  .command('serve')
  .description('Serve the headless debugger JSON-RPC protocol.')
  .option('--from-html <path>', 'serve a static HTML adapter')
  .option('--host <host>', 'host to bind', '127.0.0.1')
  .option('--port <port>', 'port to bind', Number, 45127)
  .action(async (options: ConnectionOptions & { host: string; port: number }) => {
    if (!options.fromHtml) {
      exitBridgePending()
    }
    const html = await readFile(options.fromHtml, 'utf8')
    const server = createLineJsonRpcServer(
      new DebuggerSession(await StaticHtmlAppAdapter.create({ html }))
    )
    await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve))
    const address = server.address()
    printJson({ listening: true, address })
  })

withConnectionOptions(program.command('attach').description('Attach to a debuggable Tauri app.')).action(
  async (options: ConnectionOptions) => printJson(await call(options, 'attach', targetParams(options)))
)

program
  .command('vnc')
  .description('Show the advertised VNC/noVNC visual surface for an app.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .action(async (options: { app?: string }) => {
    if (!options.app) {
      throw new Error('vnc requires --app <appId> to discover the endpoint registry')
    }
    const endpoint = await readEndpointRegistry(options.app)
    if (!endpoint.vnc) {
      throw new Error(`app ${options.app} does not advertise a VNC surface`)
    }
    printJson(endpoint.vnc)
  })

program
  .command('windows')
  .description('List known Tauri windows.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .action(async (options: ConnectionOptions) => printJson(await call(options, 'windows')))

withConnectionOptions(program.command('window').description('Inspect or control a Tauri window.'))
  .option('--action <action>', 'window action: get, focus, show, hide, minimize, unminimize, maximize, unmaximize, setSize, or setPosition', parseWindowAction, 'get')
  .option('--x <x>', 'x position for setPosition', parseNumber)
  .option('--y <y>', 'y position for setPosition', parseNumber)
  .option('--width <width>', 'width for setSize', parseNumber)
  .option('--height <height>', 'height for setSize', parseNumber)
  .action(async (options: WindowOptions) => printJson(await call(options, 'window', windowParams(options))))

withConnectionOptions(program.command('tree').description('Print a compact semantic tree.'), { scope: true })
  .option('--mode <mode>', 'tree output mode: compact or verbose', parseTreeMode)
  .option('--interactive', 'poll and stream changed semantic tree snapshots as newline-delimited JSON')
  .option('--poll-ms <ms>', 'interactive polling interval in milliseconds', parseNumber, 250)
  .option('--timeout-ms <ms>', 'stop interactive polling after this many milliseconds', parseNumber)
  .action(async (options: TreeOptions) => {
    if (options.interactive) {
      await watchTree(options)
      return
    }
    const result = (await call(options, 'tree', treeParams(options))) as { text: string }
    process.stdout.write(`${result.text}\n`)
  })

withConnectionOptions(
  program
    .command('stream')
    .description('Stream mutation-driven semantic-tree diffs as newline-delimited JSON.')
)
  .option('--since <seq>', 'resume from a previous cursor', parseNumber)
  .option('--wait-ms <ms>', 'long-poll budget per request in milliseconds', parseNumber, 1000)
  .option('--timeout-ms <ms>', 'stop streaming after this many milliseconds', parseNumber)
  .action(async (options: StreamOptions) => {
    await streamDiffs(options)
  })

withConnectionOptions(
  program.command('find').description('Find current snapshot refs by semantic role, name, or text.'),
  { scope: true }
)
  .option('--role <role>', 'semantic role to match exactly')
  .option('--name <name>', 'accessible name substring to match')
  .option('--text <text>', 'visible text substring to match')
  .option('--limit <count>', 'maximum number of matches', parseNumber)
  .action(async (options: FindOptions) => printJson(await call(options, 'find', findParams(options))))

withConnectionOptions(
  program.command('act').description('Locate, wait for actionability, and act in one request.')
    .argument('<action>', 'click, hover, focus, blur, fill, type, press, scroll, select, or check', parseLocatorAction),
  { scope: true }
)
  .option('--role <role>', 'semantic role to match exactly')
  .option('--name <name>', 'accessible name substring to match')
  .option('--text <text>', 'visible text substring to match')
  .option('--value <value>', 'action value')
  .option('--x <x>', 'horizontal scroll delta', parseNumber)
  .option('--y <y>', 'vertical scroll delta', parseNumber)
  .option('--timeout-ms <ms>', 'actionability timeout', parseNumber)
  .option('--detail', 'include the matched element in the response')
  .action(async (action: LocatorAction, options: ActOptions) =>
    printJson(await call(options, 'act', {
      ...findParams(options),
      action,
      value: action === 'check' && options.value !== undefined ? parseBoolean(options.value) : options.value,
      x: options.x,
      y: options.y,
      timeoutMs: options.timeoutMs,
      detail: options.detail
    }))
  )

registerSimpleRefCommand('click', 'Click a snapshot-local ref.', 'snapshot-local ref, for example @3')
registerSimpleRefCommand('hover', 'Hover a snapshot-local ref.', 'snapshot-local ref, for example @3')
registerSimpleRefCommand('focus', 'Focus a snapshot-local ref.', 'snapshot-local ref, for example @4')
registerSimpleRefCommand('blur', 'Blur a snapshot-local ref.', 'snapshot-local ref, for example @4')
registerSimpleRefCommand('inspect', 'Inspect a snapshot-local ref.', 'snapshot-local ref, for example @4')

withConnectionOptions(
  program
    .command('scroll')
    .description('Scroll a snapshot-local ref by x/y deltas.')
    .argument('<ref>', 'snapshot-local ref, for example @7')
    .argument('[y]', 'vertical scroll delta', parseNumber, 0)
    .argument('[x]', 'horizontal scroll delta', parseNumber, 0),
  { scope: true }
).action(async (ref: string, y: number, x: number, options: ConnectionOptions) => {
  const client = await debuggerClient(options)
  await client.call('tree', treeParams(options))
  printJson(await client.call('scroll', refActionParams(options, ref, { y, x })))
})

withConnectionOptions(
  program
    .command('drag')
    .description('Drag a snapshot-local ref to another snapshot-local ref.')
    .argument('<ref>', 'snapshot-local source ref, for example @3')
    .argument('[toRef]', 'snapshot-local target ref, for example @8'),
  { scope: true }
).action(async (ref: string, toRef: string | undefined, options: ConnectionOptions) => {
  const client = await debuggerClient(options)
  await client.call('tree', treeParams(options))
  printJson(await client.call('drag', refActionParams(options, ref, { toRef })))
})

withConnectionOptions(
  program
    .command('fill')
    .description('Fill a snapshot-local ref.')
    .argument('<ref>', 'snapshot-local ref, for example @4')
    .argument('<text>', 'text value'),
  { scope: true }
).action(async (ref: string, text: string, options: ConnectionOptions) => {
  const client = await debuggerClient(options)
  await client.call('tree', treeParams(options))
  printJson(await client.call('fill', refActionParams(options, ref, { text })))
})

withConnectionOptions(
  program
    .command('type')
    .description('Type text into a snapshot-local ref with realistic per-key events.')
    .argument('<ref>', 'snapshot-local ref, for example @4')
    .argument('<text>', 'text to type'),
  { scope: true }
).action(async (ref: string, text: string, options: ConnectionOptions) => {
  const client = await debuggerClient(options)
  await client.call('tree', treeParams(options))
  printJson(await client.call('type', refActionParams(options, ref, { text })))
})

withConnectionOptions(
  program
    .command('select')
    .description('Select an option in a snapshot-local select control.')
    .argument('<ref>', 'snapshot-local select or option ref, for example @4')
    .argument('[value]', 'option value or visible label'),
  { scope: true }
).action(async (ref: string, value: string | undefined, options: ConnectionOptions) => {
  const client = await debuggerClient(options)
  await client.call('tree', treeParams(options))
  printJson(await client.call('select', refActionParams(options, ref, { value })))
})

withConnectionOptions(
  program
    .command('check')
    .description('Set checked state on a snapshot-local checkbox or radio ref.')
    .argument('<ref>', 'snapshot-local checkbox or radio ref, for example @6')
    .argument('[checked]', 'true or false', parseBoolean),
  { scope: true }
).action(async (ref: string, checked: boolean | undefined, options: ConnectionOptions) => {
  const client = await debuggerClient(options)
  await client.call('tree', treeParams(options))
  printJson(await client.call('check', refActionParams(options, ref, { checked })))
})

withConnectionOptions(
  program
    .command('upload')
    .description('Set synthetic files on a snapshot-local file input ref.')
    .argument('<ref>', 'snapshot-local file input ref, for example @2')
    .argument('<files...>', 'file specs as name or name=text'),
  { scope: true }
).action(async (ref: string, files: string[], options: ConnectionOptions) => {
  const client = await debuggerClient(options)
  await client.call('tree', treeParams(options))
  printJson(await client.call('upload', refActionParams(options, ref, { files: parseUploadFiles(files) })))
})

withConnectionOptions(
  program
    .command('eval')
    .description('Evaluate JavaScript in the app webview.')
    .argument('<code>', 'JavaScript expression or snippet')
).action(async (code: string, options: ConnectionOptions) =>
  printJson(await call(options, 'eval', { ...targetParams(options), code }))
)

withConnectionOptions(
  program
    .command('press')
    .description('Dispatch a keyboard key.')
    .argument('<key>', 'key name, for example Enter'),
  { scope: true }
)
  .option('--ref <ref>', 'snapshot-local ref to focus before dispatching the key')
  .option('--modifier <modifier>', 'keyboard modifier: Alt, Control, Meta, or Shift', collectModifier, [])
  .action(async (key: string, options: PressOptions) => {
    const client = await debuggerClient(options)
    if (options.ref) {
      await client.call('tree', treeParams(options))
    }
    printJson(await client.call('press', pressParams(options, key)))
  })

withConnectionOptions(
  program
    .command('shot')
    .description('Capture a screenshot through the live Tauri bridge.')
    .argument('[path]', 'output path')
)
  .option('--backend <backend>', 'screenshot backend: dom, native, or auto', parseScreenshotBackend)
  .option('--ref <ref>', 'scope the capture to a single element ref (forces the DOM backend)')
  .action(async (path: string | undefined, options: ShotOptions) =>
    printJson(
      await call(options, 'shot', {
        ...targetParams(options),
        path,
        backend: options.backend,
        ref: options.ref
      })
    )
  )

registerFollowCommand('logs', 'Print captured app logs.', 'log')
registerFollowCommand('events', 'Print captured app events.', 'event')
registerFollowCommand('network', 'Print captured fetch/XHR/WebSocket network entries.', 'network')
registerFollowCommand('ipc', 'Print captured Tauri IPC invoke traces.', 'IPC')

withConnectionOptions(program.command('diagnose').description('Collect a compact debugger report.'))
  .option('--limit <count>', 'recent entries per capture surface', parseNumber, 20)
  .option('--trace-id <id>', 'filter one action trace and expand its network/IPC details')
  .action(async (options: ConnectionOptions & { limit?: number; traceId?: string }) => {
    printJson(await collectDiagnosis(await debuggerClient(options), {
      window: options.window,
      limit: options.limit,
      traceId: options.traceId
    }))
  })

withConnectionOptions(
  program.command('storage').description('Inspect or mutate webview localStorage/sessionStorage.')
)
  .option('--area <area>', 'storage area: local or session', parseStorageArea, 'local')
  .option('--action <action>', 'storage action: get, set, remove, or clear', parseStorageAction, 'get')
  .option('--key <key>', 'storage key')
  .option('--value <value>', 'storage value for set')
  .action(async (options: StorageOptions) => {
    printJson(await call(options, 'storage', storageParams(options)))
  })

withConnectionOptions(
  program.command('cookies').description('Inspect or mutate webview-visible document.cookie entries.')
)
  .option('--action <action>', 'cookie action: get, set, remove, or clear', parseCookieAction, 'get')
  .option('--name <name>', 'cookie name')
  .option('--value <value>', 'cookie value for set')
  .action(async (options: CookieOptions) => {
    printJson(await call(options, 'cookies', cookieParams(options)))
  })

withConnectionOptions(
  program
    .command('location')
    .description('Inspect or update the webview location for SPA-style navigation.')
)
  .option('--action <action>', 'location action: get, push, replace, reload, back, or forward', parseLocationAction, 'get')
  .option('--url <url>', 'URL or path for push/replace actions')
  .action(async (options: LocationOptions) => {
    printJson(await call(options, 'location', locationParams(options)))
  })

withConnectionOptions(
  program
    .command('wait')
    .description('Wait for text or a semantic element to appear (or disappear with --absent).')
    .argument('[text]', 'text to wait for'),
  { scope: true }
)
  .option('--role <role>', 'semantic role to match exactly')
  .option('--name <name>', 'accessible name substring to match')
  .option('--absent', 'wait for the target to disappear instead of appear')
  .option('--fn <expression>', 'wait until this JS expression evaluates truthy')
  .option('--network-idle', 'wait until no fetch/XHR request is in flight')
  .option('--idle-ms <ms>', 'quiet window for --network-idle in milliseconds', Number)
  .option('--timeout-ms <ms>', 'timeout in milliseconds', Number)
  .action(async (text: string | undefined, options: WaitOptions) =>
    printJson(await call(options, 'wait', waitParams(options, text)))
  )

withConnectionOptions(
  program
    .command('expect')
    .description('Assert a semantic target exists (or is absent) and matches value/state.'),
  { scope: true }
)
  .option('--role <role>', 'semantic role to match exactly')
  .option('--name <name>', 'accessible name substring to match')
  .option('--text <text>', 'visible text substring to match')
  .option('--absent', 'assert the target is absent instead of present')
  .option('--value <value>', 'assert the matched control value equals this')
  .option('--has-state <state>', 'assert the matched element has this state flag')
  .action(async (options: ExpectOptions) =>
    printJson(
      await call(options, 'expect', {
        ...targetParams(options),
        scope: options.scope,
        role: options.role,
        name: options.name,
        text: options.text,
        present: options.absent ? false : undefined,
        value: options.value,
        hasState: options.hasState
      })
    )
  )

withConnectionOptions(program.command('state').description('Print current app state probe values.'))
  .option('--key <key>', 'return one top-level state field')
  .action(async (options: StateOptions) => printJson(await call(options, 'state', stateParams(options))))

withConnectionOptions(
  program
    .command('dialog')
    .description('Read or set the auto-dialog policy (alert/confirm/prompt) and read the dialog log.')
    .argument('[action]', 'get (default), set, or clear', parseDialogAction)
)
  .option('--accept', 'accept confirm/prompt dialogs (with set)')
  .option('--no-accept', 'dismiss confirm/prompt dialogs (with set)')
  .option('--prompt-text <text>', 'text returned by accepted prompt dialogs (with set)')
  .action(async (action: 'get' | 'set' | 'clear' | undefined, options: DialogOptions) =>
    printJson(
      await call(options, 'dialog', {
        ...targetParams(options),
        action,
        accept: options.accept,
        promptText: options.promptText
      })
    )
  )

withConnectionOptions(program.command('record').description('Manage action recording.'))
  .option('--action <action>', 'start, stop, get, or clear')
  .action(async (options: ConnectionOptions & { action?: string }) =>
    printJson(await call(options, 'record', { ...targetParams(options), action: options.action }))
  )

withConnectionOptions(
  program.command('replay').description('Replay a recording JSON file against an app.')
    .argument('<path>', 'recording or Fleet replay.json path')
).action(async (path: string, options: ConnectionOptions) => {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
  const entries = recordingEntries(parsed)
  const client = await debuggerClient(options)
  for (const entry of entries) {
    const params = entry.params
    if (entry.method !== 'act' && 'ref' in params) {
      await client.call('tree', { window: options.window ?? params.window, scope: params.scope })
    }
    await client.call(entry.method, { ...params, ...(options.window ? { window: options.window } : {}) })
  }
  printJson({ replayed: entries.length })
})

await program.parseAsync()

async function call(
  options: ConnectionOptions,
  method: AgentMethod,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  return debuggerClient(options).then((client) => client.call(method, params))
}

async function followEntries(
  options: FollowOptions,
  method: 'logs' | 'events' | 'network' | 'ipc'
): Promise<void> {
  const client = await debuggerClient(options)
  const poll = pollFollow(client, method, { ...targetParams(options), since: options.since }, {
    pollMs: options.pollMs ?? 250,
    timeoutMs: options.timeoutMs
  })
  for await (const fresh of poll) {
    for (const entry of fresh) {
      process.stdout.write(`${JSON.stringify(entry)}\n`)
    }
  }
}

async function watchTree(options: TreeOptions): Promise<void> {
  const client = await debuggerClient(options)
  const pollMs = Math.max(1, options.pollMs ?? 250)
  const startedAt = Date.now()
  let previousText: string | undefined

  while (true) {
    const result = await client.call('tree', treeParams(options))
    if (!isTreeResult(result)) {
      throw new Error('tree interactive expected a { text } result')
    }

    if (result.text !== previousText) {
      process.stdout.write(`${JSON.stringify(result)}\n`)
      previousText = result.text
    }

    if (options.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs) {
      return
    }
    await sleep(nextPollDelay(startedAt, pollMs, options.timeoutMs))
  }
}

async function streamDiffs(options: StreamOptions): Promise<void> {
  const client = await debuggerClient(options)
  const startedAt = Date.now()
  const waitMs = Math.max(1, options.waitMs ?? 1000)
  let cursor = options.since

  // Emit the current full snapshot first so a consumer has a baseline to which
  // subsequent diff frames apply.
  const base = asStreamResult(await client.call('stream', { ...targetParams(options), since: cursor, lean: true }))
  if (base.snapshot !== undefined) process.stdout.write(`${JSON.stringify({ snapshot: base.snapshot, cursor: base.cursor })}\n`)
  for (const frame of base.frames) {
    process.stdout.write(`${JSON.stringify(frame)}\n`)
  }
  cursor = base.cursor

  while (true) {
    if (options.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs) {
      return
    }
    const budget =
      options.timeoutMs === undefined
        ? waitMs
        : Math.max(1, Math.min(waitMs, options.timeoutMs - (Date.now() - startedAt)))
    const result = asStreamResult(
      await client.call('stream', { ...targetParams(options), since: cursor, timeoutMs: budget, lean: true })
    )
    if (result.dropped) {
      process.stdout.write(
        `${JSON.stringify({ resync: true, snapshot: result.snapshot, cursor: result.cursor })}\n`
      )
    } else {
      for (const frame of result.frames) {
        process.stdout.write(`${JSON.stringify(frame)}\n`)
      }
    }
    cursor = result.cursor
  }
}

function asStreamResult(value: unknown): StreamResult {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Array.isArray((value as StreamResult).frames) ||
    typeof (value as StreamResult).cursor !== 'number'
  ) {
    throw new Error('stream expected a { frames, cursor, snapshot, dropped } result')
  }
  return value as StreamResult
}

function targetParams(options: ConnectionOptions): Record<string, unknown> {
  return { window: options.window }
}

function windowParams(options: WindowOptions): Record<string, unknown> {
  return {
    ...targetParams(options),
    action: options.action,
    x: options.x,
    y: options.y,
    width: options.width,
    height: options.height
  }
}

function treeParams(options: ConnectionOptions): Record<string, unknown> {
  return { ...targetParams(options), scope: options.scope, mode: options.mode }
}

function findParams(options: FindOptions): Record<string, unknown> {
  return {
    ...targetParams(options),
    scope: options.scope,
    role: options.role,
    name: options.name,
    text: options.text,
    limit: options.limit
  }
}

function storageParams(options: StorageOptions): Record<string, unknown> {
  return {
    ...targetParams(options),
    area: options.area,
    action: options.action,
    key: options.key,
    value: options.value
  }
}

function cookieParams(options: CookieOptions): Record<string, unknown> {
  return {
    ...targetParams(options),
    action: options.action,
    name: options.name,
    value: options.value
  }
}

function locationParams(options: LocationOptions): Record<string, unknown> {
  return {
    ...targetParams(options),
    action: options.action,
    url: options.url
  }
}

function waitParams(options: WaitOptions, text: string | undefined): Record<string, unknown> {
  return {
    ...targetParams(options),
    text,
    scope: options.scope,
    role: options.role,
    name: options.name,
    timeoutMs: options.timeoutMs,
    state: options.absent ? 'absent' : undefined,
    fn: options.fn,
    networkIdle: options.networkIdle ? true : undefined,
    idleMs: options.idleMs
  }
}

function stateParams(options: StateOptions): Record<string, unknown> {
  return {
    ...targetParams(options),
    key: options.key
  }
}

function pressParams(options: PressOptions, key: string): Record<string, unknown> {
  return {
    ...targetParams(options),
    key,
    ref: options.ref,
    modifiers: options.modifier?.length ? options.modifier : undefined
  }
}

function refActionParams(
  options: ConnectionOptions,
  ref: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { ...targetParams(options), ref, ...extra }
}

async function debuggerClient(options: ConnectionOptions): Promise<DebuggerClient> {
  if (!options.port && !options.app && !options.fromHtml) {
    exitBridgePending()
  }
  const fromHtml = options.fromHtml
  return connectDebuggerClient({
    port: options.port,
    host: options.host,
    app: options.app,
    resolveHtml: fromHtml ? () => readFile(fromHtml, 'utf8') : undefined
  })
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function parseDialogAction(value: string): 'get' | 'set' | 'clear' {
  if (value === 'get' || value === 'set' || value === 'clear') {
    return value
  }
  throw new Error(`invalid dialog action: ${value} (expected get, set, or clear)`)
}

function parseUploadFiles(specs: string[]): Array<{ name: string; text?: string }> {
  return specs.map((spec) => {
    const separator = spec.indexOf('=')
    return separator === -1
      ? { name: spec }
      : { name: spec.slice(0, separator), text: spec.slice(separator + 1) }
  })
}

function parseBoolean(value: string): boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`expected true or false, got ${value}`)
}

function parseLocatorAction(value: string): LocatorAction {
  if (['click', 'hover', 'focus', 'blur', 'fill', 'type', 'press', 'scroll', 'select', 'check'].includes(value)) {
    return value as LocatorAction
  }
  throw new Error(`invalid locator action: ${value}`)
}

function recordingEntries(value: unknown): Array<{ method: AgentMethod; params: Record<string, unknown> }> {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { entries?: unknown }).entries)
      ? (value as { entries: unknown[] }).entries
      : undefined
  if (!entries) throw new Error('recording must be an array or an object with entries')
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('recording entry requires a method')
    }
    const record = entry as Record<string, unknown>
    if (typeof record.method !== 'string') {
      throw new Error('recording entry requires a method')
    }
    if (!isRecordableMethod(record.method)) {
      throw new Error(`recording contains unsupported method: ${record.method}`)
    }
    if (
      record.params !== undefined &&
      (typeof record.params !== 'object' || record.params === null || Array.isArray(record.params))
    ) {
      throw new Error(`recording entry ${index + 1} params must be an object`)
    }
    return {
      method: record.method,
      params: (record.params ?? {}) as Record<string, unknown>
    }
  })
}

function parseScreenshotBackend(value: string): ScreenshotBackend {
  if (value === 'dom' || value === 'native' || value === 'auto') {
    return value
  }
  throw new Error(`unknown screenshot backend: ${value}`)
}

function parseNumber(value: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid number: ${value}`)
  }
  return parsed
}

function parseTreeMode(value: string): 'compact' | 'verbose' {
  if (value === 'compact' || value === 'verbose') {
    return value
  }
  throw new Error(`expected compact or verbose, got ${value}`)
}

function parseStorageArea(value: string): 'local' | 'session' {
  if (value === 'local' || value === 'session') {
    return value
  }
  throw new Error(`expected local or session, got ${value}`)
}

function parseStorageAction(value: string): 'get' | 'set' | 'remove' | 'clear' {
  if (value === 'get' || value === 'set' || value === 'remove' || value === 'clear') {
    return value
  }
  throw new Error(`expected get, set, remove, or clear, got ${value}`)
}

function parseCookieAction(value: string): 'get' | 'set' | 'remove' | 'clear' {
  if (value === 'get' || value === 'set' || value === 'remove' || value === 'clear') {
    return value
  }
  throw new Error(`expected get, set, remove, or clear, got ${value}`)
}

function parseLocationAction(
  value: string
): 'get' | 'push' | 'replace' | 'reload' | 'back' | 'forward' {
  if (
    value === 'get' ||
    value === 'push' ||
    value === 'replace' ||
    value === 'reload' ||
    value === 'back' ||
    value === 'forward'
  ) {
    return value
  }
  throw new Error(`expected get, push, replace, reload, back, or forward, got ${value}`)
}

function parseWindowAction(value: string): WindowAction {
  if (
    value === 'get' ||
    value === 'focus' ||
    value === 'show' ||
    value === 'hide' ||
    value === 'minimize' ||
    value === 'unminimize' ||
    value === 'maximize' ||
    value === 'unmaximize' ||
    value === 'setSize' ||
    value === 'setPosition'
  ) {
    return value
  }
  throw new Error(`expected a window action, got ${value}`)
}

function collectModifier(value: string, previous: KeyModifier[]): KeyModifier[] {
  return [...previous, parseKeyModifier(value)]
}

function parseKeyModifier(value: string): KeyModifier {
  if (value === 'Alt' || value === 'Control' || value === 'Meta' || value === 'Shift') {
    return value
  }
  throw new Error(`expected Alt, Control, Meta, or Shift, got ${value}`)
}

function nextPollDelay(startedAt: number, pollMs: number, timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return pollMs
  }
  return Math.max(0, Math.min(pollMs, timeoutMs - (Date.now() - startedAt)))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isTreeResult(value: unknown): value is { text: string } {
  return typeof value === 'object' && value !== null && 'text' in value && typeof value.text === 'string'
}

function exitBridgePending(): never {
  process.stderr.write(
    'live Tauri attach needs --app for endpoint discovery, --port for a known daemon, or --from-html for deterministic protocol prototyping.\n'
  )
  process.exit(2)
}
