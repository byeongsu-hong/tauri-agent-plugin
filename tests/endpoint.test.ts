import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  createEndpointDescriptor,
  endpointRegistryPath,
  endpointRuntimeDir,
  parseEndpointDescriptor,
  readEndpointRegistry,
  removeEndpointRegistry,
  writeEndpointRegistry
} from '../daemon/endpoint'

describe('debugger endpoint discovery', () => {
  it('uses app-specific runtime paths instead of one global tmp socket', () => {
    expect(
      endpointRuntimeDir({
        appId: 'dev.byeongsu.fixture',
        env: { XDG_RUNTIME_DIR: '/run/user/501' }
      })
    ).toBe('/run/user/501/tauri-agent/dev.byeongsu.fixture')

    expect(
      endpointRegistryPath({
        appId: 'dev.byeongsu.fixture',
        env: { XDG_RUNTIME_DIR: '/run/user/501' }
      })
    ).toBe('/run/user/501/tauri-agent/dev.byeongsu.fixture/endpoint.json')

    expect(
      createEndpointDescriptor({
        appId: 'dev.byeongsu.fixture',
        pid: 4242,
        env: { XDG_RUNTIME_DIR: '/run/user/501' }
      })
    ).toEqual({
      appId: 'dev.byeongsu.fixture',
      pid: 4242,
      transport: 'unix',
      path: '/run/user/501/tauri-agent/dev.byeongsu.fixture/4242.sock'
    })
  })

  it('uses explicit TCP endpoint descriptors for fallback transports', () => {
    const descriptor = createEndpointDescriptor({
      appId: 'dev.byeongsu.fixture',
      pid: 4242,
      tcp: { host: '127.0.0.1', port: 45127 }
    })

    expect(descriptor).toEqual({
      appId: 'dev.byeongsu.fixture',
      pid: 4242,
      transport: 'tcp',
      host: '127.0.0.1',
      port: 45127
    })
    expect(parseEndpointDescriptor(JSON.stringify(descriptor))).toEqual(descriptor)
    expect(() => parseEndpointDescriptor('{"transport":"unix"}')).toThrow(
      'invalid endpoint descriptor'
    )
  })

  it('writes, reads, and removes app-specific endpoint registry files', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'tauri-agent-endpoint-'))
    const env = { XDG_RUNTIME_DIR: runtimeDir }
    const descriptor = createEndpointDescriptor({
      appId: 'dev.byeongsu.fixture',
      pid: 4242,
      env
    })

    await writeEndpointRegistry(descriptor, { env })
    await expect(readEndpointRegistry('dev.byeongsu.fixture', { env })).resolves.toEqual(descriptor)

    await removeEndpointRegistry('dev.byeongsu.fixture', { env })
    await expect(readEndpointRegistry('dev.byeongsu.fixture', { env })).rejects.toThrow(
      'endpoint registry not found for app: dev.byeongsu.fixture'
    )
  })
})
