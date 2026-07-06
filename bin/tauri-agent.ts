#!/usr/bin/env node
import { readFile } from 'node:fs/promises'

import { Command } from 'commander'
import { JSDOM } from 'jsdom'

import { clickRef, fillRef, pressKey, snapshotDocument } from '../guest-js/semantic-tree'

const program = new Command()

program
  .name('tauri-agent')
  .description('Agent-facing CLI for compact Tauri app semantic trees.')
  .version('0.1.0')

program
  .command('tree')
  .description('Print a compact semantic tree.')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--scope <selector>', 'limit the snapshot to a CSS selector')
  .option('--interactive', 'reserved for the live Tauri bridge')
  .action(async (options: { fromHtml?: string; scope?: string; interactive?: boolean }) => {
    if (!options.fromHtml) {
      exitBridgePending('tree')
    }

    const dom = await domFromHtmlFile(options.fromHtml)
    const snapshot = snapshotDocument(dom.window.document, { scope: options.scope })
    process.stdout.write(`${snapshot.text}\n`)
  })

program
  .command('click')
  .description('Click a snapshot-local ref.')
  .argument('<ref>', 'snapshot-local ref, for example @3')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--scope <selector>', 'limit the snapshot to a CSS selector')
  .action(async (ref: string, options: { fromHtml?: string; scope?: string }) => {
    await prepareStaticSnapshot(options)
    clickRef(ref)
  })

program
  .command('fill')
  .description('Fill a snapshot-local ref.')
  .argument('<ref>', 'snapshot-local ref, for example @4')
  .argument('<text>', 'text value')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--scope <selector>', 'limit the snapshot to a CSS selector')
  .action(async (ref: string, text: string, options: { fromHtml?: string; scope?: string }) => {
    await prepareStaticSnapshot(options)
    fillRef(ref, text)
  })

program
  .command('press')
  .description('Dispatch a keyboard key.')
  .argument('<key>', 'key name, for example Enter')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--scope <selector>', 'limit the snapshot to a CSS selector')
  .action(async (key: string, options: { fromHtml?: string; scope?: string }) => {
    await prepareStaticSnapshot(options)
    pressKey(key)
  })

program
  .command('shot')
  .description('Capture a screenshot through the live Tauri bridge.')
  .argument('[path]', 'output path')
  .action(() => exitBridgePending('shot'))

program
  .command('events')
  .description('Stream live Tauri app events.')
  .action(() => exitBridgePending('events'))

await program.parseAsync()

async function prepareStaticSnapshot(options: { fromHtml?: string; scope?: string }): Promise<void> {
  if (!options.fromHtml) {
    exitBridgePending('action')
  }
  const dom = await domFromHtmlFile(options.fromHtml)
  snapshotDocument(dom.window.document, { scope: options.scope })
}

async function domFromHtmlFile(path: string): Promise<JSDOM> {
  const html = await readFile(path, 'utf8')
  const dom = new JSDOM(html, { pretendToBeVisual: true })
  bindDomGlobals(dom)
  return dom
}

function bindDomGlobals(dom: JSDOM): void {
  globalThis.document = dom.window.document
  globalThis.Element = dom.window.Element
  globalThis.Document = dom.window.Document
  globalThis.Event = dom.window.Event
  globalThis.HTMLInputElement = dom.window.HTMLInputElement
  globalThis.HTMLSelectElement = dom.window.HTMLSelectElement
  globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  globalThis.Node = dom.window.Node
}

function exitBridgePending(command: string): never {
  process.stderr.write(
    `tauri-agent ${command} needs the live Tauri bridge. v0 supports formatter prototyping with --from-html.\n`
  )
  process.exit(2)
}
