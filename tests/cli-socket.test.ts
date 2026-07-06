import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type Server } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { createEndpointDescriptor, writeEndpointRegistry } from '../daemon/endpoint'

let server: ChildProcessWithoutNullStreams | undefined
let fakeRpcServer: Server | undefined
const PROCESS_SPAWNING_TEST_TIMEOUT_MS = 20000

type RpcResponse = unknown | ((callIndex: number) => unknown)

afterEach(() => {
  server?.kill()
  server = undefined
  fakeRpcServer?.close()
  fakeRpcServer = undefined
})

function htmlFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tauri-agent-cli-socket-'))
  const path = join(dir, 'screen.html')
  writeFileSync(
    path,
    '<main aria-label="Ducktape"><label>Agent name<input aria-label="Agent name"></label></main>'
  )
  return path
}

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('bun', ['bin/tauri-agent.ts', ...args], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8'
  }).trim()
}

async function runCliAsync(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'bun',
      ['bin/tauri-agent.ts', ...args],
      {
        cwd: process.cwd(),
        env,
        encoding: 'utf8'
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}\n${stderr}`.trim()))
          return
        }
        resolve(stdout.trim())
      }
    )
  })
}

async function startServer(path: string, port: number): Promise<void> {
  server = spawn('bun', ['bin/tauri-agent.ts', 'serve', '--from-html', path, '--port', String(port)], {
    cwd: process.cwd()
  })

  let output = ''
  server.stdout.on('data', (chunk) => {
    output += chunk.toString('utf8')
  })

  const startedAt = Date.now()
  while (!output.includes('"listening": true')) {
    if (Date.now() - startedAt > 3000) {
      throw new Error(`server did not start: ${output}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function startCapturingRpcServer(responses: Record<string, RpcResponse>): Promise<{
  port: number
  requests: Array<{ method: string; params?: unknown }>
}> {
  const requests: Array<{ method: string; params?: unknown }> = []
  const callCounts = new Map<string, number>()
  fakeRpcServer = createServer((socket) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        const request = JSON.parse(line) as { id: number; method: string; params?: unknown }
        requests.push({ method: request.method, params: request.params })
        const callIndex = callCounts.get(request.method) ?? 0
        callCounts.set(request.method, callIndex + 1)
        const response = responses[request.method]
        const result = typeof response === 'function' ? response(callIndex) : response
        socket.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: result ?? { ok: true }
          })}\n`,
          () => socket.end()
        )
        newlineIndex = buffer.indexOf('\n')
      }
    })
  })

  await new Promise<void>((resolve) => fakeRpcServer?.listen(0, '127.0.0.1', resolve))
  const address = fakeRpcServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('fake RPC server did not bind to a TCP port')
  }
  return { port: address.port, requests }
}

describe('tauri-agent CLI socket mode', () => {
  it('controls a persistent headless debugger daemon', async () => {
    const port = 45138
    await startServer(htmlFile(), port)

    expect(runCli(['tree', '--port', String(port)])).toBe(
      'main "Ducktape"\n@1 textbox "Agent name" empty'
    )
    expect(JSON.parse(runCli(['fill', '@1', 'worker-a', '--port', String(port)]))).toEqual({ ok: true })
    expect(JSON.parse(runCli(['state', '--port', String(port)]))).toEqual({
      url: 'tauri-agent://static',
      title: 'Tauri App',
      values: {
        'Agent name': 'worker-a'
      }
    })
  }, PROCESS_SPAWNING_TEST_TIMEOUT_MS)

  it('discovers a persistent debugger daemon from an app endpoint registry', async () => {
    const port = 45139
    const appId = 'dev.byeongsu.fixture'
    const runtimeDir = mkdtempSync(join(tmpdir(), 'tauri-agent-cli-registry-'))
    const env = { ...process.env, XDG_RUNTIME_DIR: runtimeDir }
    await startServer(htmlFile(), port)
    await writeEndpointRegistry(
      createEndpointDescriptor({
        appId,
        pid: process.pid,
        tcp: { host: '127.0.0.1', port }
      }),
      { env }
    )

    expect(JSON.parse(runCli(['windows', '--app', appId], env))).toEqual([
      { label: 'main', title: 'Tauri App', focused: true, visible: true }
    ])
  }, PROCESS_SPAWNING_TEST_TIMEOUT_MS)

  it('forwards --window to ref command snapshot refresh and action calls', async () => {
    const { port, requests } = await startCapturingRpcServer({
      tree: { text: '@3 button "Forge"' },
      click: { ok: true }
    })

    expect(
      JSON.parse(await runCliAsync(['click', '@3', '--port', String(port), '--window', 'secondary', '--scope', 'main']))
    ).toEqual({ ok: true })
    expect(requests).toEqual([
      { method: 'tree', params: { window: 'secondary', scope: 'main' } },
      { method: 'click', params: { window: 'secondary', ref: '@3' } }
    ])
  })

  it('forwards --window to direct protocol commands', async () => {
    const { port, requests } = await startCapturingRpcServer({
      state: { url: 'tauri-agent://fake', title: 'Fake', values: {} }
    })

    expect(JSON.parse(await runCliAsync(['state', '--port', String(port), '--window', 'secondary']))).toEqual({
      url: 'tauri-agent://fake',
      title: 'Fake',
      values: {}
    })
    expect(requests).toEqual([{ method: 'state', params: { window: 'secondary' } }])
  })

  it('streams changed semantic trees in interactive mode', async () => {
    const first = { text: 'main "Ducktape"\n@1 status "Loading"' }
    const second = { text: 'main "Ducktape"\n@1 status "Ready"' }
    const { port, requests } = await startCapturingRpcServer({
      tree: (callIndex: number) => (callIndex === 0 ? first : second)
    })

    const output = await runCliAsync([
      'tree',
      '--port',
      String(port),
      '--window',
      'secondary',
      '--scope',
      'main',
      '--interactive',
      '--poll-ms',
      '10',
      '--timeout-ms',
      '200'
    ])

    expect(output.split('\n').map((line) => JSON.parse(line))).toEqual([first, second])
    const treeRequests = requests.filter((request) => request.method === 'tree')
    expect(treeRequests.length).toBeGreaterThanOrEqual(2)
    expect(treeRequests.every((request) => JSON.stringify(request.params) === JSON.stringify({
      window: 'secondary',
      scope: 'main'
    }))).toBe(true)
  })

  it('forwards tree mode to protocol calls', async () => {
    const { port, requests } = await startCapturingRpcServer({
      tree: { text: 'main "Ducktape"' }
    })

    expect(await runCliAsync(['tree', '--port', String(port), '--window', 'secondary', '--mode', 'verbose'])).toBe(
      'main "Ducktape"'
    )
    expect(requests).toEqual([{ method: 'tree', params: { window: 'secondary', mode: 'verbose' } }])
  })

  it.each([
    {
      command: 'logs',
      first: { level: 'info', message: 'booted', timestamp: '2026-07-07T00:00:00.000Z' },
      second: { level: 'warn', message: 'ready', timestamp: '2026-07-07T00:00:00.100Z' }
    },
    {
      command: 'events',
      first: { kind: 'click', timestamp: '2026-07-07T00:00:00.000Z', detail: { ref: '@3' } },
      second: { kind: 'focus', timestamp: '2026-07-07T00:00:00.100Z', detail: { ref: '@4' } }
    }
  ])('streams new $command entries in follow mode', async ({ command, first, second }) => {
    const { port, requests } = await startCapturingRpcServer({
      [command]: (callIndex: number) => (callIndex === 0 ? [first] : [first, second])
    })

    const output = await runCliAsync([
      command,
      '--port',
      String(port),
      '--follow',
      '--poll-ms',
      '10',
      '--timeout-ms',
      '200'
    ])

    expect(output.split('\n').map((line) => JSON.parse(line))).toEqual([first, second])
    const followRequests = requests.filter((request) => request.method === command)
    expect(followRequests.length).toBeGreaterThanOrEqual(2)
    expect(followRequests.every((request) => JSON.stringify(request.params) === JSON.stringify({ follow: true }))).toBe(
      true
    )
  })
})
