import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import { afterEach, describe, expect, it } from 'vitest'

import { createEndpointDescriptor, writeEndpointRegistry } from '../daemon/endpoint'

let server: ChildProcessWithoutNullStreams | undefined

afterEach(() => {
  server?.kill()
  server = undefined
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
  })

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
  })
})
