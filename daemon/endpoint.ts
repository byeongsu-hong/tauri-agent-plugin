import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface EndpointPathOptions {
  appId: string
  env?: Partial<Pick<NodeJS.ProcessEnv, 'XDG_RUNTIME_DIR' | 'TMPDIR' | 'TEMP' | 'TMP'>>
}

/**
 * Discovery record for the human-facing VNC/noVNC visual surface. The plugin
 * only advertises where the stream lives; the surrounding harness runs the
 * actual VNC server.
 */
export interface VncEndpoint {
  host: string
  port: number
  novncUrl?: string
}

export interface EndpointDescriptorOptions extends EndpointPathOptions {
  pid: number
  tcp?: {
    host: string
    port: number
  }
  token?: string
  vnc?: VncEndpoint
}

export type EndpointDescriptor =
  | {
      appId: string
      pid: number
      transport: 'unix'
      path: string
      token?: string
      vnc?: VncEndpoint
    }
  | {
      appId: string
      pid: number
      transport: 'tcp'
      host: string
      port: number
      token?: string
      vnc?: VncEndpoint
    }

export function endpointRuntimeDir(options: EndpointPathOptions): string {
  const env = options.env ?? process.env
  return join(runtimeBaseDir(env), 'tauri-agent', safeAppId(options.appId))
}

export function endpointRegistryPath(options: EndpointPathOptions): string {
  return join(endpointRuntimeDir(options), 'endpoint.json')
}

export function createEndpointDescriptor(options: EndpointDescriptorOptions): EndpointDescriptor {
  const extra = {
    ...(options.token ? { token: options.token } : {}),
    ...(options.vnc ? { vnc: options.vnc } : {})
  }
  if (options.tcp) {
    return {
      appId: options.appId,
      pid: options.pid,
      transport: 'tcp',
      host: options.tcp.host,
      port: options.tcp.port,
      ...extra
    }
  }

  return {
    appId: options.appId,
    pid: options.pid,
    transport: 'unix',
    path: join(endpointRuntimeDir(options), `${options.pid}.sock`),
    ...extra
  }
}

export function parseEndpointDescriptor(json: string): EndpointDescriptor {
  const parsed = JSON.parse(json) as unknown
  if (!isObject(parsed) || !isNonEmptyString(parsed.appId) || !isPositiveU32(parsed.pid)) {
    throw new Error('invalid endpoint descriptor')
  }

  const vnc = parseVnc(parsed.vnc)
  const token = optionalNonEmptyString(parsed.token, 'token')

  if (
    parsed.transport === 'unix' &&
    isNonEmptyString(parsed.path)
  ) {
    return {
      appId: parsed.appId,
      pid: parsed.pid,
      transport: 'unix',
      path: parsed.path,
      ...token,
      ...vnc
    }
  }

  if (
    parsed.transport === 'tcp' &&
    isNonEmptyString(parsed.host) &&
    isPositiveU16(parsed.port)
  ) {
    return {
      appId: parsed.appId,
      pid: parsed.pid,
      transport: 'tcp',
      host: parsed.host,
      port: parsed.port,
      ...token,
      ...vnc
    }
  }

  throw new Error('invalid endpoint descriptor')
}

function parseVnc(value: unknown): { vnc?: VncEndpoint } {
  if (value === undefined || value === null) {
    return {}
  }
  if (!isObject(value) || !isNonEmptyString(value.host) || !isPositiveU16(value.port)) {
    throw new Error('invalid endpoint descriptor')
  }
  const vnc: VncEndpoint = { host: value.host, port: value.port }
  Object.assign(vnc, optionalNonEmptyString(value.novncUrl, 'novncUrl'))
  return { vnc }
}

export async function writeEndpointRegistry(
  descriptor: EndpointDescriptor,
  options: { env?: EndpointPathOptions['env'] } = {}
): Promise<void> {
  const runtimeDir = endpointRuntimeDir({ appId: descriptor.appId, env: options.env })
  const path = endpointRegistryPath({ appId: descriptor.appId, env: options.env })
  const temporaryPath = join(runtimeDir, `endpoint.tmp.${process.pid}`)
  await mkdir(runtimeDir, { recursive: true })
  try {
    await writeFile(temporaryPath, `${JSON.stringify(descriptor, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
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
  const sanitized = appId.replace(/[^A-Za-z0-9._-]/g, '_')
  // An empty or dot-only segment ("", ".", "..") would escape the runtime
  // directory when joined as a path component; neutralize it.
  if (sanitized.length === 0) {
    return '_'
  }
  if (/^\.+$/.test(sanitized)) {
    return sanitized.replace(/\./g, '_')
  }
  return sanitized
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPositiveU32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 0xffff_ffff
}

function isPositiveU16(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 0xffff
}

function optionalNonEmptyString(value: unknown, key: string): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (!isNonEmptyString(value)) throw new Error('invalid endpoint descriptor')
  return { [key]: value }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
