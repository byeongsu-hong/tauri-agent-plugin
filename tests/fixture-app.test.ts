import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('example fixture Tauri app', () => {
  it('is wired to the local plugin build and exposes agent-testable controls', () => {
    const packageJson = JSON.parse(readFileSync('examples/fixture-app/package.json', 'utf8'))
    expect(packageJson.scripts).toMatchObject({
      dev: 'vite --host 127.0.0.1 --port 1420',
      'tauri:dev': 'tauri dev'
    })
    expect(packageJson.dependencies).not.toHaveProperty('@byeongsu-hong/tauri-agent-plugin')

    const cargoToml = readFileSync('examples/fixture-app/src-tauri/Cargo.toml', 'utf8')
    expect(cargoToml).toContain('tauri-agent-plugin = { path = "../../.." }')

    const tauriConfig = JSON.parse(
      readFileSync('examples/fixture-app/src-tauri/tauri.conf.json', 'utf8')
    )
    expect(tauriConfig.app.windows.map((window: { label?: string }) => window.label ?? 'main')).toEqual([
      'main',
      'secondary'
    ])

    const libRs = readFileSync('examples/fixture-app/src-tauri/src/lib.rs', 'utf8')
    expect(libRs).toContain('.plugin(tauri_agent_plugin::init())')

    const capability = JSON.parse(
      readFileSync('examples/fixture-app/src-tauri/capabilities/default.json', 'utf8')
    )
    expect(capability.windows).toEqual(['main', 'secondary'])
    expect(capability.permissions).toContain('agent:default')

    const appTs = readFileSync('examples/fixture-app/src/main.ts', 'utf8')
    expect(appTs).toContain("from '../../../dist-js/index.js'")
    expect(appTs).toContain('new WebviewAgentInstrumentation')
    expect(appTs).toContain('getCurrentWindow')
    expect(appTs).toContain('fixtureWindowLabel')
    expect(appTs).toContain('windowLabel: fixtureWindowLabel')
    expect(appTs).toContain('windowLabel: () => fixtureWindowLabel')
    expect(appTs).toContain('lastShortcut: () => lastShortcut')
    expect(appTs).toContain('agentSnapshot({ scope: \'main\' })')
    expect(appTs).toContain('modifiers: [\'Meta\', \'Shift\']')
    expect(appTs).toContain('agentState()')
    expect(appTs).toContain('agentAction')
    expect(appTs).toContain('agentBlur')
    expect(appTs).toContain('agentCheck')
    expect(appTs).toContain('agentDrag')
    expect(appTs).toContain('agentEval')
    expect(appTs).toContain('agentFind')
    expect(appTs).toContain('agentFocus')
    expect(appTs).toContain('agentHover')
    expect(appTs).toContain('agentInspect')
    expect(appTs).toContain('agentLocation')
    expect(appTs).toContain('agentNetwork')
    expect(appTs).toContain('agentSelect')
    expect(appTs).toContain('agentScroll')
    expect(appTs).toContain('agentSnapshot')
    expect(appTs).toContain('agentStorage')
    expect(appTs).toContain('data-action="bridge-self-test"')
    expect(appTs).toContain('data-view="agents"')
    expect(appTs).toContain('Agent name')
    expect(appTs).toContain('Register')
  })
})
