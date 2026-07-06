import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('example fixture Tauri app', () => {
  it('is wired to the local plugin package and exposes agent-testable controls', () => {
    const packageJson = JSON.parse(readFileSync('examples/fixture-app/package.json', 'utf8'))
    expect(packageJson.scripts).toMatchObject({
      dev: 'vite --host 127.0.0.1 --port 1420',
      'tauri:dev': 'tauri dev'
    })
    expect(packageJson.dependencies['@byeongsu-hong/tauri-plugin-agent']).toBe('file:../..')

    const cargoToml = readFileSync('examples/fixture-app/src-tauri/Cargo.toml', 'utf8')
    expect(cargoToml).toContain('tauri-plugin-agent = { path = "../../.." }')

    const libRs = readFileSync('examples/fixture-app/src-tauri/src/lib.rs', 'utf8')
    expect(libRs).toContain('.plugin(tauri_plugin_agent::init())')

    const capability = readFileSync(
      'examples/fixture-app/src-tauri/capabilities/default.json',
      'utf8'
    )
    expect(capability).toContain('agent:default')

    const appTs = readFileSync('examples/fixture-app/src/main.ts', 'utf8')
    expect(appTs).toContain('new WebviewAgentInstrumentation')
    expect(appTs).toContain('agentAction')
    expect(appTs).toContain('agentCheck')
    expect(appTs).toContain('agentEval')
    expect(appTs).toContain('agentHover')
    expect(appTs).toContain('agentInspect')
    expect(appTs).toContain('agentSelect')
    expect(appTs).toContain('agentSnapshot')
    expect(appTs).toContain('data-action="bridge-self-test"')
    expect(appTs).toContain('data-view="agents"')
    expect(appTs).toContain('Agent name')
    expect(appTs).toContain('Register')
  })
})
