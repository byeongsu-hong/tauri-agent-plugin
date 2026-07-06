import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

const PROCESS_SPAWNING_TEST_TIMEOUT_MS = 60000

function runCli(args: string[]): string {
  return execFileSync('bun', ['bin/tauri-agent.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8'
  }).trim()
}

function runCliFailure(args: string[]): string {
  const result = spawnSync('bun', ['bin/tauri-agent.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8'
  })
  expect(result.status).not.toBe(0)
  return `${result.stdout}${result.stderr}`
}

function htmlFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tauri-agent-cli-'))
  const path = join(dir, 'screen.html')
  writeFileSync(
    path,
    '<main aria-label="Ducktape"><button>Forge</button><label>Agent name<input aria-label="Agent name"></label><select aria-label="Worker"><option value="local">Local worker</option><option value="remote">Remote worker</option></select><label><input type="checkbox" aria-label="Notify"> Notify</label><ul aria-label="Roster"><li>local-worker</li></ul><button type="button">Drop zone</button><p>Registered worker-a</p></main>'
  )
  return path
}

describe('tauri-agent CLI', () => {
  it('routes static HTML commands through the headless debugger protocol', () => {
    const path = htmlFile()

    expect(JSON.parse(runCli(['windows', '--from-html', path]))).toEqual([
      staticWindowInfo('Tauri App')
    ])
    expect(
      JSON.parse(runCli(['window', '--action', 'setSize', '--width', '800', '--height', '600', '--from-html', path]))
    ).toEqual({
      ...staticWindowInfo('Tauri App'),
      innerBounds: { x: 0, y: 0, width: 800, height: 600 },
      outerBounds: { x: 0, y: 0, width: 800, height: 600 }
    })
    expect(runCli(['tree', '--from-html', path])).toBe(
      [
        'main "Ducktape"',
        '@1 button "Forge"',
        '@2 textbox "Agent name" empty',
        '@3 combobox "Worker"',
        '  @4 option "Local worker" selected',
        '  @5 option "Remote worker"',
        '@6 checkbox "Notify"',
        '@7 list "Roster" 1',
        '@8 button "Drop zone"'
      ].join('\n')
    )
    expect(JSON.parse(runCli(['find', '--role', 'button', '--name', 'forge', '--limit', '1', '--from-html', path]))).toEqual({
      matches: [
        expect.objectContaining({
          ref: '@1',
          role: 'button',
          name: 'Forge',
          tagName: 'button',
          text: 'Forge'
        })
      ]
    })
    expect(JSON.parse(runCli(['inspect', '@2', '--from-html', path]))).toEqual({
      ref: '@2',
      role: 'textbox',
      name: 'Agent name',
      tagName: 'input',
      text: '',
      value: '',
      attributes: {
        'aria-label': 'Agent name'
      },
      states: ['empty']
    })
    expect(JSON.parse(runCli(['hover', '@1', '--from-html', path]))).toEqual({ ok: true })
    expect(JSON.parse(runCli(['focus', '@2', '--from-html', path]))).toEqual({ ok: true })
    expect(JSON.parse(runCli(['blur', '@2', '--from-html', path]))).toEqual({ ok: true })
    expect(JSON.parse(runCli(['scroll', '@7', '12', '3', '--from-html', path]))).toEqual({ ok: true })
    expect(JSON.parse(runCli(['drag', '@1', '@8', '--from-html', path]))).toEqual({ ok: true })
    expect(JSON.parse(runCli(['fill', '@2', 'worker-a', '--from-html', path]))).toEqual({ ok: true })
    expect(JSON.parse(runCli(['select', '@3', 'remote', '--from-html', path]))).toEqual({ ok: true })
    expect(JSON.parse(runCli(['check', '@6', 'true', '--from-html', path]))).toEqual({ ok: true })
    expect(
      JSON.parse(runCli(['press', 'k', '--ref', '@2', '--modifier', 'Meta', '--modifier', 'Shift', '--from-html', path]))
    ).toEqual({ ok: true })
    expect(
      JSON.parse(runCli(['eval', 'document.querySelector("input")?.getAttribute("aria-label")', '--from-html', path]))
    ).toEqual({
      type: 'string',
      value: 'Agent name',
      text: 'Agent name'
    })
    expect(JSON.parse(runCli(['state', '--from-html', path]))).toEqual({
      url: 'tauri-agent://static',
      title: 'Tauri App',
      values: { 'Agent name': '', Notify: false, Worker: 'local' }
    })
    expect(JSON.parse(runCli(['state', '--key', 'values', '--from-html', path]))).toEqual({
      'Agent name': '',
      Notify: false,
      Worker: 'local'
    })
    expect(JSON.parse(runCli(['logs', '--from-html', path]))).toEqual([])
    expect(JSON.parse(runCli(['events', '--from-html', path]))).toEqual([])
    expect(JSON.parse(runCli(['network', '--from-html', path]))).toEqual([])
    expect(
      JSON.parse(runCli(['storage', '--action', 'set', '--key', 'agent.token', '--value', 'ready', '--from-html', path]))
    ).toEqual({
      area: 'local',
      entries: [{ area: 'local', key: 'agent.token', value: 'ready' }]
    })
    expect(
      JSON.parse(runCli(['location', '--action', 'push', '--url', '/agents?view=debug#roster', '--from-html', path]))
    ).toEqual({
      href: 'tauri-agent://static/agents?view=debug#roster',
      origin: 'null',
      pathname: '/agents',
      search: '?view=debug',
      hash: '#roster'
    })
    expect(JSON.parse(runCli(['wait', 'Registered worker-a', '--from-html', path]))).toEqual({
      matched: true,
      text: 'Registered worker-a'
    })
    expect(JSON.parse(runCli(['wait', '--role', 'button', '--name', 'Forge', '--from-html', path]))).toEqual({
      matched: true,
      text: 'Forge',
      match: expect.objectContaining({
        ref: '@1',
        role: 'button',
        name: 'Forge',
        tagName: 'button',
        text: 'Forge'
      })
    })
    const shotPath = join(tmpdir(), 'tauri-agent-static-shot.svg')
    const shot = JSON.parse(runCli(['shot', shotPath, '--from-html', path]))
    expect(shot).toEqual({
      path: shotPath,
      mime: 'image/svg+xml',
      width: expect.any(Number),
      height: expect.any(Number)
    })
    expect(shot.width).toBeGreaterThan(0)
    expect(shot.height).toBeGreaterThan(0)
    expect(readFileSync(shotPath, 'utf8')).toContain('Ducktape')
    const domShot = JSON.parse(runCli(['shot', '--backend', 'dom', '--from-html', path]))
    expect(domShot).toEqual({
      dataUrl: expect.stringMatching(/^data:image\/svg\+xml;base64,/),
      mime: 'image/svg+xml',
      width: expect.any(Number),
      height: expect.any(Number)
    })
    expect(runCliFailure(['shot', '--backend', 'native', '--from-html', path])).toContain(
      'native screenshot backend requires a live Tauri window'
    )
    expect(JSON.parse(runCli(['record', '--from-html', path]))).toEqual({
      recording: false,
      entries: []
    })
  }, PROCESS_SPAWNING_TEST_TIMEOUT_MS)
})

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
