import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface EndpointPathOptions {
  appId: string
  env?: Partial<Pick<NodeJS.ProcessEnv, 'XDG_RUNTIME_DIR' | 'TMPDIR' | 'TEMP' | 'TMP'>>
}

export interface EndpointDescriptorOptions extends EndpointPathOptions {
  pid: number
  tcp?: {
    host: string
    port: number
  }
}

export type EndpointDescriptor =
  | {
      appId: string
      pid: number
      transport: 'unix'
      path: string
    }
  | {
      appId: string
      pid: number
      transport: 'tcp'
      host: string
      port: number
    }

export function endpointRuntimeDir(options: EndpointPathOptions): string {
  const env = options.env ?? process.env
  return join(runtimeBaseDir(env), 'tauri-agent', safeAppId(options.appId))
}

export function endpointRegistryPath(options: EndpointPathOptions): string {
  return join(endpointRuntimeDir(options), 'endpoint.json')
}

export function createEndpointDescriptor(options: EndpointDescriptorOptions): EndpointDescriptor {
  if (options.tcp) {
    return {
      appId: options.appId,
      pid: options.pid,
      transport: 'tcp',
      host: options.tcp.host,
      port: options.tcp.port
    }
  }

  return {
    appId: options.appId,
    pid: options.pid,
    transport: 'unix',
    path: join(endpointRuntimeDir(options), `${options.pid}.sock`)
  }
}

export function parseEndpointDescriptor(json: string): EndpointDescriptor {
  const parsed = JSON.parse(json) as unknown
  if (!isObject(parsed) || typeof parsed.appId !== 'string' || typeof parsed.pid !== 'number') {
    throw new Error('invalid endpoint descriptor')
  }

  if (
    parsed.transport === 'unix' &&
    typeof parsed.path === 'string'
  ) {
    return {
      appId: parsed.appId,
      pid: parsed.pid,
      transport: 'unix',
      path: parsed.path
    }
  }

  if (
    parsed.transport === 'tcp' &&
    typeof parsed.host === 'string' &&
    typeof parsed.port === 'number'
  ) {
    return {
      appId: parsed.appId,
      pid: parsed.pid,
      transport: 'tcp',
      host: parsed.host,
      port: parsed.port
    }
  }

  throw new Error('invalid endpoint descriptor')
}

export async function writeEndpointRegistry(
  descriptor: EndpointDescriptor,
  options: { env?: EndpointPathOptions['env'] } = {}
): Promise<void> {
  const runtimeDir = endpointRuntimeDir({ appId: descriptor.appId, env: options.env })
  await mkdir(runtimeDir, { recursive: true })
  await writeFile(
    endpointRegistryPath({ appId: descriptor.appId, env: options.env }),
    `${JSON.stringify(descriptor, null, 2)}\n`,
    'utf8'
  )
}

export async function readEndpointRegistry(
  appId: string,
  options: { env?: EndpointPathOptions['env'] } = {}
): Promise<EndpointDescriptor> {
  const path = endpointRegistryPath({ appId, env: options.env })
  try {
    return parseEndpointDescriptor(await readFile(path, 'utf8'))
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(`endpoint registry not found for app: ${appId}`)
    }
    throw error
  }
}

export async function removeEndpointRegistry(
  appId: string,
  options: { env?: EndpointPathOptions['env'] } = {}
): Promise<void> {
  await rm(endpointRegistryPath({ appId, env: options.env }), { force: true })
}

function runtimeBaseDir(env: EndpointPathOptions['env']): string {
  return env?.XDG_RUNTIME_DIR ?? env?.TMPDIR ?? env?.TEMP ?? env?.TMP ?? tmpdir()
}

function safeAppId(appId: string): string {
  return appId.replace(/[^A-Za-z0-9._-]/g, '_')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
