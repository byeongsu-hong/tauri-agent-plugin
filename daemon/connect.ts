import { DebuggerClient, SocketTransport } from './client'
import { readEndpointRegistry } from './endpoint'
import { createDebuggerRpcHandler, InProcessTransport } from './server'
import { DebuggerSession } from './session'
import { StaticHtmlAppAdapter } from './static-app'
import type { AgentMethod } from '../protocol/types'

/** How to reach a debugger: a live daemon port, an app registry, or static HTML. */
export interface DebuggerTarget {
  port?: number
  host?: string
  app?: string
  /** Resolve the static HTML to prototype against; only awaited when no port/app. */
  resolveHtml?: () => Promise<string>
}

export function validateDebuggerTarget(target: DebuggerTarget): void {
  if (
    target.port !== undefined &&
    (!Number.isInteger(target.port) || target.port < 1 || target.port > 65_535)
  ) {
    throw new Error('debugger port must be an integer between 1 and 65535')
  }
  if (target.app !== undefined && !target.app.trim()) {
    throw new Error('debugger app id must be non-empty')
  }
  if (target.host !== undefined && !target.host.trim()) {
    throw new Error('debugger host must be non-empty')
  }
  if (target.host !== undefined && target.port === undefined) {
    throw new Error('debugger host requires a port connection source')
  }
  const sources = [
    target.port !== undefined,
    target.app !== undefined,
    target.resolveHtml !== undefined
  ].filter(Boolean).length
  if (sources !== 1) {
    throw new Error('debugger target requires exactly one connection source: port, app, or HTML')
  }
}

/**
 * Build a {@link DebuggerClient} from a target. Shared by the CLI and the MCP
 * server so both discover endpoints, verify liveness, and fall back to a static
 * adapter identically. Returns null-free: throws with an actionable message.
 */
export async function connectDebuggerClient(target: DebuggerTarget): Promise<DebuggerClient> {
  validateDebuggerTarget(target)
  if (target.port !== undefined) {
    return new DebuggerClient(new SocketTransport({ port: target.port, host: target.host ?? '127.0.0.1' }))
  }
  if (target.app) {
    const endpoint = await readEndpointRegistry(target.app)
    if (!isProcessAlive(endpoint.pid)) {
      throw new Error(
        `debugger endpoint for app ${target.app} is stale: pid ${endpoint.pid} is not running`
      )
    }
    return new DebuggerClient(
      new SocketTransport(
        endpoint.transport === 'tcp'
          ? { port: endpoint.port, host: endpoint.host }
          : { path: endpoint.path }
      ),
      endpoint.token
    )
  }
  if (!target.resolveHtml) {
    throw new Error('no debugger target: provide a daemon port, an --app id, or static HTML')
  }
  const html = await target.resolveHtml()
  const session = new DebuggerSession(await StaticHtmlAppAdapter.create({ html }))
  return new DebuggerClient(new InProcessTransport(createDebuggerRpcHandler(session)))
}

/**
 * Liveness probe used before trusting a discovered endpoint. `EPERM` means the
 * pid exists but is owned by another user, which still counts as alive.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'
  }
}

/** Collect a compact cross-surface debugger report without adding a protocol method. */
export async function collectDiagnosis(
  client: DebuggerClient,
  options: { window?: string; limit?: number; traceId?: string } = {}
): Promise<Record<string, unknown>> {
  const limit = Math.max(1, Math.min(100, options.limit ?? 20))
  if (options.traceId !== undefined && !options.traceId.trim()) throw new Error('traceId must be non-empty')
  const target = options.window ? { window: options.window } : {}
  const [attach, state, logs, events, network, ipc] = await Promise.all([
    client.call('attach', target),
    client.call('state', target),
    client.call('logs', target),
    client.call('events', target),
    client.call('network', target),
    client.call('ipc', target)
  ])
  const selectedLogs = recentEntries(logs, limit, 'logs', options.traceId)
  const selectedEvents = recentEntries(events, limit, 'events', options.traceId)
  const selectedNetwork = recentEntries(network, limit, 'network', options.traceId)
  const selectedIpc = recentEntries(ipc, limit, 'ipc', options.traceId)
  const [networkResult, ipcResult] = options.traceId
    ? await Promise.all([
        retainedDetails(client, 'network', target, selectedNetwork),
        retainedDetails(client, 'ipc', target, selectedIpc)
      ])
    : [selectedNetwork, selectedIpc]
  return {
    capturedAt: new Date().toISOString(),
    ...(options.traceId ? { traceId: options.traceId } : {}),
    attach,
    state,
    logs: selectedLogs,
    events: selectedEvents,
    network: networkResult,
    ipc: ipcResult
  }
}

function recentEntries(value: unknown, limit: number, method: string, traceId?: string): unknown[] {
  if (!isCaptureResult(value)) throw new Error(`${method} expected a capture result`)
  return value.entries.filter((entry) => traceId === undefined || (
    typeof entry === 'object' && entry !== null && (entry as { traceId?: unknown }).traceId === traceId
  )).slice(-limit)
}

async function retainedDetails(
  client: DebuggerClient,
  method: 'network' | 'ipc',
  target: Record<string, unknown>,
  entries: unknown[]
): Promise<unknown[]> {
  return Promise.all(entries.map(async (entry) => {
    if (typeof entry !== 'object' || entry === null || typeof (entry as { id?: unknown }).id !== 'string') {
      throw new Error(`${method} trace entry expected an id`)
    }
    const result = await client.call(method, { ...target, id: (entry as { id: string }).id })
    if (typeof result !== 'object' || result === null || !('detail' in result)) {
      throw new Error(`${method} expected a detail result`)
    }
    return result.detail
  }))
}

/**
 * Poll a capture method, yielding only entries appended after its cursor.
 * Shared by the CLI (streams to stdout) and the MCP server (accumulates into a
 * bounded result). Without `timeoutMs` it streams until the caller stops
 * iterating; with it, it returns once the budget elapses.
 */
export async function* pollFollow(
  client: DebuggerClient,
  method: AgentMethod,
  params: Record<string, unknown>,
  options: { pollMs: number; timeoutMs?: number }
): AsyncGenerator<unknown[]> {
  const startedAt = Date.now()
  const pollMs = Math.max(1, options.pollMs)
  let cursor = typeof params.since === 'number' ? params.since : 0
  while (true) {
    const result = await client.call(method, { ...params, since: cursor })
    if (!isCaptureResult(result)) {
      throw new Error(`${method} follow expected a capture result`)
    }
    cursor = result.cursor
    if (result.entries.length > 0) {
      yield result.entries
    }
    if (options.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs) {
      return
    }
    await sleep(nextPollDelay(startedAt, pollMs, options.timeoutMs))
  }
}

function isCaptureResult(value: unknown): value is { entries: unknown[]; cursor: number } {
  return typeof value === 'object' && value !== null
    && Array.isArray((value as { entries?: unknown }).entries)
    && typeof (value as { cursor?: unknown }).cursor === 'number'
}

function nextPollDelay(startedAt: number, pollMs: number, timeoutMs?: number): number {
  if (timeoutMs === undefined) {
    return pollMs
  }
  const remaining = timeoutMs - (Date.now() - startedAt)
  return Math.max(1, Math.min(pollMs, remaining))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
