import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { readEndpointRegistry } from '../daemon/endpoint'

const APP_ID = 'dev.byeongsu.tauri-agent.fixture'
const CLI = fileURLToPath(new URL('../dist-cli/tauri-agent.js', import.meta.url))
const execute = promisify(execFile)

const endpoint = await waitForEndpoint()
try {
  const attach = await cliJson<{ protocolVersion: number; windows: Array<{ label: string }> }>('attach')
  assert.equal(attach.protocolVersion, 2)
  assert.deepEqual(attach.windows.map(({ label }) => label).sort(), ['main', 'secondary'])

  const tree = await waitForTree()
  assert.match(tree, /textbox "Agent name"/)
  const found = await cliJson<{ matches: Array<{ role: string; name: string }> }>(
    'find', '--role', 'button', '--name', 'Register'
  )
  assert(found.matches.some(({ role, name }) => role === 'button' && name === 'Register'))

  await cliJson('act', 'fill', '--role', 'textbox', '--name', 'Agent name', '--value', 'external-worker')
  const state = await cliJson<{ values: Record<string, unknown> }>('state')
  assert.equal(state.values['Agent name'], 'external-worker')
  const action = await cliJson<{ traceId: string }>('act', 'click', '--role', 'button', '--name', 'Register')
  assert.match(action.traceId, /^action-\d+$/)
  await cliJson('wait', 'Registered external-worker', '--timeout-ms', '5000')

  const diagnosis = await cliJson<{
    traceId: string
    logs: Array<{ message: string; traceId?: string }>
    events: Array<{ kind: string; traceId?: string }>
    network: Array<{ url: string; requestHeaders?: Record<string, string>; requestBody?: Record<string, unknown> }>
    ipc: Array<{ command: string }>
  }>('diagnose', '--trace-id', action.traceId)
  assert.equal(diagnosis.traceId, action.traceId)
  assert(diagnosis.logs.some(({ message, traceId }) => message === 'registered external-worker' && traceId === action.traceId))
  assert(diagnosis.events.some(({ kind, traceId }) => kind === 'click' && traceId === action.traceId))
  assert(diagnosis.network.some(({ url, requestHeaders, requestBody }) =>
    !url.includes('fixture-secret') &&
    requestHeaders?.authorization === '[REDACTED]' &&
    requestBody?.token === '[REDACTED]'
  ))
  assert(diagnosis.ipc.some(({ command }) => command.includes('window')))

  assert.match(await runCli('tree', '--window', 'secondary'), /Ducktape secondary/)
  process.stdout.write('external fixture smoke test passed\n')
} finally {
  try {
    process.kill(endpoint.pid, 'SIGTERM')
  } catch {}
}

async function waitForEndpoint() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      return await readEndpointRegistry(APP_ID)
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw new Error('fixture endpoint was not published within 30 seconds')
}

async function waitForTree(): Promise<string> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const tree = await runCli('tree')
      if (tree.includes('Agent name')) return tree
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('fixture webview was not ready within 30 seconds')
}

async function cliJson<T = unknown>(...args: string[]): Promise<T> {
  return JSON.parse(await runCli(...args)) as T
}

async function runCli(...args: string[]): Promise<string> {
  const { stdout } = await execute(process.execPath, [CLI, ...args, '--app', APP_ID], {
    env: process.env,
    timeout: 10_000
  })
  return stdout.trim()
}
