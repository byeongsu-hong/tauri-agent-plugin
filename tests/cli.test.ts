import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

function runCli(args: string[]): string {
  return execFileSync('bun', ['bin/tauri-agent.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8'
  }).trim()
}

function htmlFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tauri-agent-cli-'))
  const path = join(dir, 'screen.html')
  writeFileSync(
    path,
    '<main aria-label="Ducktape"><button>Forge</button><label>Agent name<input aria-label="Agent name"></label><p>Registered worker-a</p></main>'
  )
  return path
}

describe('tauri-agent CLI', () => {
  it('routes static HTML commands through the headless debugger protocol', () => {
    const path = htmlFile()

    expect(JSON.parse(runCli(['windows', '--from-html', path]))).toEqual([
      { label: 'main', title: 'Tauri App', focused: true, visible: true }
    ])
    expect(runCli(['tree', '--from-html', path])).toBe(
      'main "Ducktape"\n@1 button "Forge"\n@2 textbox "Agent name" empty'
    )
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
    expect(JSON.parse(runCli(['fill', '@2', 'worker-a', '--from-html', path]))).toEqual({ ok: true })
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
      values: { 'Agent name': '' }
    })
    expect(JSON.parse(runCli(['logs', '--from-html', path]))).toEqual([])
    expect(JSON.parse(runCli(['events', '--from-html', path]))).toEqual([])
    expect(JSON.parse(runCli(['wait', 'Registered worker-a', '--from-html', path]))).toEqual({
      matched: true,
      text: 'Registered worker-a'
    })
    const shotPath = join(tmpdir(), 'tauri-agent-static-shot.svg')
    expect(JSON.parse(runCli(['shot', shotPath, '--from-html', path]))).toEqual({
      path: shotPath,
      mime: 'image/svg+xml'
    })
    expect(readFileSync(shotPath, 'utf8')).toContain('Ducktape')
    expect(JSON.parse(runCli(['record', '--from-html', path]))).toEqual({
      recording: false,
      entries: []
    })
  })
})
