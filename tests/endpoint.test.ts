import { describe, expect, it } from 'vitest'

import {
  createEndpointDescriptor,
  endpointRegistryPath,
  endpointRuntimeDir,
  parseEndpointDescriptor
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
})
