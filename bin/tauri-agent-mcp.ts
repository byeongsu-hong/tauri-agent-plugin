#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { Command } from 'commander'

import { createMcpRequestHandler } from '../mcp/server'
import { serveMcpStdio } from '../mcp/stdio'

const program = new Command()
  .name('tauri-agent-mcp')
  .option('--app <appId>', 'scope every tool to one app endpoint')
  .option('--port <port>', 'scope every tool to one debugger port', Number)
  .option('--host <host>', 'debugger host', '127.0.0.1')
  .option('--from-html <path>', 'scope every tool to one static HTML file')
  .option('--profile <profile>', 'tool profile: core or full', 'full')

program.parse()
const options = program.opts<{ app?: string; port?: number; host: string; fromHtml?: string; profile: string }>()
if (options.profile !== 'core' && options.profile !== 'full') throw new Error('profile must be core or full')
const target = options.app || options.port !== undefined || options.fromHtml
  ? {
      app: options.app,
      port: options.port,
      host: options.host,
      resolveHtml: options.fromHtml ? () => readFile(options.fromHtml!, 'utf8') : undefined
    }
  : undefined

serveMcpStdio(createMcpRequestHandler({ target, profile: options.profile }))
