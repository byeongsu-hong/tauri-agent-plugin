#!/usr/bin/env node
import { readFile } from 'node:fs/promises'

import { Command } from 'commander'

import { DebuggerClient, SocketTransport } from '../daemon/client'
import { readEndpointRegistry } from '../daemon/endpoint'
import { createDebuggerRpcHandler, createLineJsonRpcServer, InProcessTransport } from '../daemon/server'
import { DebuggerSession } from '../daemon/session'
import { StaticHtmlAppAdapter } from '../daemon/static-app'
import type { AgentMethod } from '../protocol/types'

interface ConnectionOptions {
  app?: string
  fromHtml?: string
  scope?: string
  host?: string
  port?: number
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
    const server = createLineJsonRpcServer(new DebuggerSession(new StaticHtmlAppAdapter({ html })))
    await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve))
    const address = server.address()
    printJson({ listening: true, address })
  })

program
  .command('attach')
  .description('Attach to a debuggable Tauri app.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .action(async (options: ConnectionOptions) => printJson(await call(options, 'attach')))

program
  .command('windows')
  .description('List known Tauri windows.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .action(async (options: ConnectionOptions) => printJson(await call(options, 'windows')))

program
  .command('tree')
  .description('Print a compact semantic tree.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--scope <selector>', 'limit the snapshot to a CSS selector')
  .option('--interactive', 'reserved for the live Tauri bridge')
  .action(async (options: ConnectionOptions & { interactive?: boolean }) => {
    const result = (await call(options, 'tree', { scope: options.scope })) as { text: string }
    process.stdout.write(`${result.text}\n`)
  })

program
  .command('click')
  .description('Click a snapshot-local ref.')
  .argument('<ref>', 'snapshot-local ref, for example @3')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--scope <selector>', 'limit the snapshot to a CSS selector')
  .action(async (ref: string, options: ConnectionOptions) => {
    const client = await debuggerClient(options)
    await client.call('tree', { scope: options.scope })
    printJson(await client.call('click', { ref }))
  })

program
  .command('fill')
  .description('Fill a snapshot-local ref.')
  .argument('<ref>', 'snapshot-local ref, for example @4')
  .argument('<text>', 'text value')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--scope <selector>', 'limit the snapshot to a CSS selector')
  .action(async (ref: string, text: string, options: ConnectionOptions) => {
    const client = await debuggerClient(options)
    await client.call('tree', { scope: options.scope })
    printJson(await client.call('fill', { ref, text }))
  })

program
  .command('press')
  .description('Dispatch a keyboard key.')
  .argument('<key>', 'key name, for example Enter')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .action(async (key: string, options: ConnectionOptions) => printJson(await call(options, 'press', { key })))

program
  .command('shot')
  .description('Capture a screenshot through the live Tauri bridge.')
  .argument('[path]', 'output path')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <htmlPath>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .action(async (path: string | undefined, options: ConnectionOptions) =>
    printJson(await call(options, 'shot', { path }))
  )

program
  .command('logs')
  .description('Print captured app logs.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--follow', 'reserved for live streaming')
  .action(async (options: ConnectionOptions & { follow?: boolean }) =>
    printJson(await call(options, 'logs', { follow: options.follow }))
  )

program
  .command('events')
  .description('Print captured app events.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--follow', 'reserved for live streaming')
  .action(async (options: ConnectionOptions & { follow?: boolean }) =>
    printJson(await call(options, 'events', { follow: options.follow }))
  )

program
  .command('wait')
  .description('Wait for text to appear.')
  .argument('<text>', 'text to wait for')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--timeout-ms <ms>', 'timeout in milliseconds', Number)
  .action(async (text: string, options: ConnectionOptions & { timeoutMs?: number }) =>
    printJson(await call(options, 'wait', { text, timeoutMs: options.timeoutMs }))
  )

program
  .command('state')
  .description('Print current app state probe values.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .action(async (options: ConnectionOptions) => printJson(await call(options, 'state')))

program
  .command('record')
  .description('Manage action recording.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--action <action>', 'start, stop, get, or clear')
  .action(async (options: ConnectionOptions & { action?: string }) =>
    printJson(await call(options, 'record', { action: options.action }))
  )

await program.parseAsync()

async function call(
  options: ConnectionOptions,
  method: AgentMethod,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  return debuggerClient(options).then((client) => client.call(method, params))
}

async function debuggerClient(options: ConnectionOptions): Promise<DebuggerClient> {
  if (options.port) {
    return new DebuggerClient(new SocketTransport({ port: options.port, host: options.host }))
  }
  if (options.app) {
    const endpoint = await readEndpointRegistry(options.app)
    return new DebuggerClient(
      new SocketTransport(
        endpoint.transport === 'tcp'
          ? { port: endpoint.port, host: endpoint.host }
          : { path: endpoint.path }
      )
    )
  }
  if (!options.fromHtml) {
    exitBridgePending()
  }

  const html = await readFile(options.fromHtml, 'utf8')
  const session = new DebuggerSession(new StaticHtmlAppAdapter({ html }))
  return new DebuggerClient(new InProcessTransport(createDebuggerRpcHandler(session)))
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function exitBridgePending(): never {
  process.stderr.write(
    'live Tauri attach needs --app for endpoint discovery, --port for a known daemon, or --from-html for deterministic protocol prototyping.\n'
  )
  process.exit(2)
}
