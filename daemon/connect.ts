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

/**
 * Build a {@link DebuggerClient} from a target. Shared by the CLI and the MCP
 * server so both discover endpoints, verify liveness, and fall back to a static
 * adapter identically. Returns null-free: throws with an actionable message.
 */
export async function connectDebuggerClient(target: DebuggerTarget): Promise<DebuggerClient> {
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

/**
 * Poll a follow-capable method, yielding only the entries appended since the
 * last poll (length-based diff, resilient to a clear that shrinks the buffer).
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
  let emitted = 0
  while (true) {
    const result = await client.call(method, { ...params, follow: true })
    if (!Array.isArray(result)) {
      throw new Error(`${method} follow expected an array result`)
    }
    const start = result.length < emitted ? 0 : emitted
    const fresh = result.slice(start)
    emitted = result.length
    if (fresh.length > 0) {
      yield fresh
    }
    if (options.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs) {
      return
    }
    await sleep(nextPollDelay(startedAt, pollMs, options.timeoutMs))
  }
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
