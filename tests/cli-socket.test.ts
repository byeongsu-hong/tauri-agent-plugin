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
  while (!output.includes('"listening":true')) {
    if (Date.now() - startedAt > 3000) {
      throw new Error(`server did not start: ${output}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function unusedPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  if (!address || typeof address === 'string') throw new Error('port probe did not bind')
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return address.port
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

function staticWindowInfo(title: string): Record<string, unknown> {
  return {
    label: 'main',
    title,
    focused: true,
    visible: true,
    minimized: false,
    maximized: false,
    scaleFactor: 1,
    innerBounds: { x: 0, y: 0, width: 1024, height: 768 },
    outerBounds: { x: 0, y: 0, width: 1024, height: 768 }
  }
}

describe('tauri-agent CLI socket mode', () => {
  it('does not allow the unauthenticated static server to bind beyond loopback', () => {
    expect(() =>
      runCli(['serve', '--from-html', htmlFile(), '--host', '0.0.0.0'])
    ).toThrow(/unknown option '--host'/)
  })

  it('rejects malformed and ambiguous debugger connection sources', async () => {
    await expect(runCliAsync(['windows', '--port', '0'])).rejects.toThrow(
      'debugger port must be an integer between 1 and 65535'
    )
    await expect(
      runCliAsync(['windows', '--port', '45127', '--from-html', htmlFile()])
    ).rejects.toThrow('debugger target requires exactly one connection source')
    await expect(
      runCliAsync(['windows', '--from-html', htmlFile(), '--host', 'localhost'])
    ).rejects.toThrow('debugger host requires a port connection source')
    await expect(runCliAsync(['windows', '--host', 'localhost'])).rejects.toThrow(
      'debugger host requires a port connection source'
    )
  })

  it('controls a persistent headless debugger daemon', async () => {
    const port = await unusedPort()
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
    const port = await unusedPort()
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
      staticWindowInfo('Tauri App')
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

  it('forwards atomic locator actions without a ref refresh', async () => {
    const result = { ok: true, match: { ref: '@3', name: 'Save' } }
    const { port, requests } = await startCapturingRpcServer({ act: result })

    expect(JSON.parse(await runCliAsync([
      'act', 'click', '--port', String(port), '--window', 'secondary', '--role', 'button', '--name', 'Save', '--timeout-ms', '250'
    ]))).toEqual(result)
    expect(requests).toEqual([{
      method: 'act',
      params: { window: 'secondary', role: 'button', name: 'Save', action: 'click', timeoutMs: 250 }
    }])
  })

  it('replays recorded protocol actions sequentially', async () => {
    const { port, requests } = await startCapturingRpcServer({ act: { ok: true } })
    const path = join(mkdtempSync(join(tmpdir(), 'tauri-agent-replay-')), 'replay.json')
    writeFileSync(path, JSON.stringify({ entries: [
      { method: 'act', params: { role: 'button', name: 'Save', action: 'click' }, timestamp: new Date().toISOString() }
    ] }))

    expect(JSON.parse(await runCliAsync(['replay', path, '--port', String(port)]))).toEqual({ replayed: 1 })
    expect(requests).toEqual([{ method: 'act', params: { role: 'button', name: 'Save', action: 'click' } }])
  })

  it('validates an entire recording before replaying any action', async () => {
    const { port, requests } = await startCapturingRpcServer({ act: { ok: true } })
    const path = join(mkdtempSync(join(tmpdir(), 'tauri-agent-invalid-replay-')), 'replay.json')
    const valid = { method: 'act', params: { role: 'button', name: 'Save', action: 'click' } }

    writeFileSync(path, JSON.stringify({ entries: [valid, { method: 'missing', params: {} }] }))
    await expect(runCliAsync(['replay', path, '--port', String(port)]))
      .rejects.toThrow('recording contains unsupported method: missing')

    writeFileSync(path, JSON.stringify({ entries: [valid, { method: 'click', params: [] }] }))
    await expect(runCliAsync(['replay', path, '--port', String(port)]))
      .rejects.toThrow('recording entry 2 params must be an object')

    expect(requests).toEqual([])
  })

  it('forwards state keys to protocol calls', async () => {
    const { port, requests } = await startCapturingRpcServer({
      state: { 'Agent name': 'worker-a' }
    })

    expect(JSON.parse(await runCliAsync(['state', '--port', String(port), '--window', 'secondary', '--key', 'values']))).toEqual({
      'Agent name': 'worker-a'
    })
    expect(requests).toEqual([{ method: 'state', params: { window: 'secondary', key: 'values' } }])
  })

  it('forwards press target refs and modifiers to protocol calls', async () => {
    const { port, requests } = await startCapturingRpcServer({
      tree: { text: '@2 textbox "Agent name" empty' },
      press: { ok: true }
    })

    expect(
      JSON.parse(
        await runCliAsync([
          'press',
          'k',
          '--port',
          String(port),
          '--window',
          'secondary',
          '--scope',
          'main',
          '--ref',
          '@2',
          '--modifier',
          'Meta',
          '--modifier',
          'Shift'
        ])
      )
    ).toEqual({ ok: true })
    expect(requests).toEqual([
      { method: 'tree', params: { window: 'secondary', scope: 'main' } },
      { method: 'press', params: { window: 'secondary', key: 'k', ref: '@2', modifiers: ['Meta', 'Shift'] } }
    ])
  })

  it('forwards window control options to protocol calls', async () => {
    const response = {
      label: 'secondary',
      title: 'Secondary',
      focused: true,
      visible: true,
      minimized: false,
      maximized: false,
      scaleFactor: 2,
      innerBounds: { x: 0, y: 0, width: 640, height: 480 },
      outerBounds: { x: 0, y: 0, width: 640, height: 480 }
    }
    const { port, requests } = await startCapturingRpcServer({
      window: response
    })

    expect(
      JSON.parse(
        await runCliAsync([
          'window',
          '--port',
          String(port),
          '--window',
          'secondary',
          '--action',
          'setSize',
          '--width',
          '640',
          '--height',
          '480'
        ])
      )
    ).toEqual(response)
    expect(requests).toEqual([
      { method: 'window', params: { window: 'secondary', action: 'setSize', width: 640, height: 480 } }
    ])
  })

  it('forwards semantic wait filters to protocol calls', async () => {
    const response = {
      matched: true,
      text: 'Forge',
      match: { ref: '@3', role: 'button', name: 'Forge', tagName: 'button', text: 'Forge', attributes: {}, states: [] }
    }
    const { port, requests } = await startCapturingRpcServer({
      wait: response
    })

    expect(
      JSON.parse(
        await runCliAsync([
          'wait',
          '--port',
          String(port),
          '--window',
          'secondary',
          '--scope',
          'main',
          '--role',
          'button',
          '--name',
          'Forge',
          '--timeout-ms',
          '250'
        ])
      )
    ).toEqual(response)
    expect(requests).toEqual([
      { method: 'wait', params: { window: 'secondary', scope: 'main', role: 'button', name: 'Forge', timeoutMs: 250 } }
    ])
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

  it('streams mutation-driven semantic diffs as newline-delimited JSON', async () => {
    const base = { frames: [], cursor: 0, snapshot: 'main "Ducktape"\n@1 button "One"', dropped: false }
    const change = {
      frames: [{ seq: 1, added: ['@2 button "Two"'], removed: [] }],
      cursor: 1,
      snapshot: 'main "Ducktape"\n@1 button "One"\n@2 button "Two"',
      dropped: false
    }
    const idle = { frames: [], cursor: 1, snapshot: change.snapshot, dropped: false }
    const { port, requests } = await startCapturingRpcServer({
      stream: (callIndex: number) => (callIndex === 0 ? base : callIndex === 1 ? change : idle)
    })

    const output = await runCliAsync([
      'stream',
      '--port',
      String(port),
      '--wait-ms',
      '10',
      '--timeout-ms',
      '80'
    ])

    const lines = output
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    // First line is the baseline snapshot; the mutation frame follows.
    expect(lines[0]).toEqual({ snapshot: base.snapshot, cursor: 0 })
    expect(lines).toContainEqual({ seq: 1, added: ['@2 button "Two"'], removed: [] })

    const streamRequests = requests.filter((request) => request.method === 'stream')
    expect(streamRequests.length).toBeGreaterThanOrEqual(2)
    // The cursor advances: the first follow call resumes from the baseline cursor.
    expect(streamRequests[1].params).toMatchObject({ since: 0 })
  }, PROCESS_SPAWNING_TEST_TIMEOUT_MS)

  it('forwards tree mode to protocol calls', async () => {
    const { port, requests } = await startCapturingRpcServer({
      tree: { text: 'main "Ducktape"' }
    })

    expect(await runCliAsync(['tree', '--port', String(port), '--window', 'secondary', '--mode', 'verbose'])).toBe(
      'main "Ducktape"'
    )
    expect(requests).toEqual([{ method: 'tree', params: { window: 'secondary', mode: 'verbose' } }])
  })

  it('forwards find filters to protocol calls', async () => {
    const response = {
      matches: [{ ref: '@3', role: 'button', name: 'Forge', tagName: 'button', text: 'Forge', attributes: {}, states: [] }]
    }
    const { port, requests } = await startCapturingRpcServer({
      find: response
    })

    expect(
      JSON.parse(
        await runCliAsync([
          'find',
          '--port',
          String(port),
          '--window',
          'secondary',
          '--scope',
          'main',
          '--role',
          'button',
          '--name',
          'forge',
          '--limit',
          '1'
        ])
      )
    ).toEqual(response)
    expect(requests).toEqual([
      { method: 'find', params: { window: 'secondary', scope: 'main', role: 'button', name: 'forge', limit: 1 } }
    ])
  })

  it('forwards network options to protocol calls', async () => {
    const { port, requests } = await startCapturingRpcServer({
      network: { entries: [], cursor: 0, dropped: false }
    })

    expect(
      JSON.parse(await runCliAsync(['network', '--port', String(port), '--window', 'secondary', '--clear']))
    ).toEqual({ entries: [], cursor: 0, dropped: false })
    expect(requests).toEqual([{ method: 'network', params: { window: 'secondary', clear: true } }])
  })

  it.each([
    ['logs', { entries: [{ level: 'info', message: 'booted', timestamp: '2026-07-07T00:00:00.000Z' }], cursor: 1, dropped: false }],
    ['events', { entries: [{ kind: 'click', timestamp: '2026-07-07T00:00:00.000Z', detail: { ref: '@3' } }], cursor: 1, dropped: false }]
  ])('forwards %s clear options to protocol calls', async (command, response) => {
    const { port, requests } = await startCapturingRpcServer({
      [command]: response
    })

    expect(
      JSON.parse(await runCliAsync([command, '--port', String(port), '--window', 'secondary', '--clear']))
    ).toEqual(response)
    expect(requests).toEqual([{ method: command, params: { window: 'secondary', clear: true } }])
  })

  it('forwards storage options to protocol calls', async () => {
    const response = {
      area: 'session',
      entries: [{ area: 'session', key: 'agent.route', value: '/agents' }]
    }
    const { port, requests } = await startCapturingRpcServer({
      storage: response
    })

    expect(
      JSON.parse(
        await runCliAsync([
          'storage',
          '--port',
          String(port),
          '--window',
          'secondary',
          '--area',
          'session',
          '--action',
          'set',
          '--key',
          'agent.route',
          '--value',
          '/agents'
        ])
      )
    ).toEqual(response)
    expect(requests).toEqual([
      {
        method: 'storage',
        params: { window: 'secondary', area: 'session', action: 'set', key: 'agent.route', value: '/agents' }
      }
    ])
  })

  it('forwards cookie options to protocol calls', async () => {
    const response = {
      entries: [{ name: 'agent.cookie', value: 'ready' }]
    }
    const { port, requests } = await startCapturingRpcServer({
      cookies: response
    })

    expect(
      JSON.parse(
        await runCliAsync([
          'cookies',
          '--port',
          String(port),
          '--window',
          'secondary',
          '--action',
          'set',
          '--name',
          'agent.cookie',
          '--value',
          'ready'
        ])
      )
    ).toEqual(response)
    expect(requests).toEqual([
      {
        method: 'cookies',
        params: { window: 'secondary', action: 'set', name: 'agent.cookie', value: 'ready' }
      }
    ])
  })

  it('forwards location options to protocol calls', async () => {
    const response = {
      href: 'tauri-agent://static/agents?view=debug#roster',
      origin: 'null',
      pathname: '/agents',
      search: '?view=debug',
      hash: '#roster'
    }
    const { port, requests } = await startCapturingRpcServer({
      location: response
    })

    expect(
      JSON.parse(
        await runCliAsync([
          'location',
          '--port',
          String(port),
          '--window',
          'secondary',
          '--action',
          'push',
          '--url',
          '/agents?view=debug#roster'
        ])
      )
    ).toEqual(response)
    expect(requests).toEqual([
      {
        method: 'location',
        params: { window: 'secondary', action: 'push', url: '/agents?view=debug#roster' }
      }
    ])
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
    },
    {
      command: 'network',
      first: {
        id: 'fetch-1',
        type: 'fetch',
        method: 'GET',
        url: 'https://example.test/api/agents',
        startedAt: '2026-07-07T00:00:00.000Z'
      },
      second: {
        id: 'fetch-2',
        type: 'fetch',
        method: 'POST',
        url: 'https://example.test/api/agents',
        status: 201,
        ok: true,
        startedAt: '2026-07-07T00:00:00.100Z',
        endedAt: '2026-07-07T00:00:00.150Z',
        durationMs: 50
      }
    }
  ])('streams new $command entries in follow mode', async ({ command, first, second }) => {
    const { port, requests } = await startCapturingRpcServer({
      [command]: (callIndex: number) => callIndex === 0
        ? { entries: [first], cursor: 8, dropped: false }
        : callIndex === 1
          ? { entries: [second], cursor: 9, dropped: false }
          : { entries: [], cursor: 9, dropped: false }
    })

    const output = await runCliAsync([
      command,
      '--port',
      String(port),
      '--follow',
      '--since',
      '7',
      '--poll-ms',
      '10',
      '--timeout-ms',
      '200'
    ])

    expect(output.split('\n').map((line) => JSON.parse(line))).toEqual([first, second])
    const followRequests = requests.filter((request) => request.method === command)
    expect(followRequests.length).toBeGreaterThanOrEqual(2)
    expect(followRequests.slice(0, 2).map((request) =>
      (request.params as { since?: number } | undefined)?.since
    )).toEqual([7, 8])
  })
})
