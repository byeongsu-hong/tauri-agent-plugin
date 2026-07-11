import { AgentProtocolError } from '../protocol/error'
import type { ActParams, InspectResult } from '../protocol/types'

const POLL_MS = 25

export async function locateActionable(
  params: ActParams,
  find: (params: ActParams) => InspectResult[],
  stable: (match: InspectResult) => Promise<boolean> = async () => true
): Promise<InspectResult | undefined> {
  validateAction(params)
  const hasLocator = Boolean(params.scope || params.role || params.name || params.text)
  if (!hasLocator) {
    if (params.action === 'press') return undefined
    throw new AgentProtocolError('INVALID_PARAMS', 'act requires a locator')
  }

  const deadline = Date.now() + Math.max(0, params.timeoutMs ?? 1_000)
  let blocked: InspectResult | undefined
  let unstable = false
  do {
    const matches = find({ ...params, limit: 2 })
    if (matches.length > 1) {
      throw new AgentProtocolError('LOCATOR_AMBIGUOUS', 'act locator matched more than one element')
    }
    const match = matches[0]
    if (match) {
      blocked = match
      if (isActionable(match, params.action)) {
        if (await stable(match)) return match
        unstable = true
      }
    }
    if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  } while (Date.now() < deadline)

  if (unstable) throw new AgentProtocolError('ACTION_TIMEOUT', 'matched element did not become stable')
  throw blocked
    ? new AgentProtocolError('NOT_ACTIONABLE', `matched ${blocked.ref} did not become actionable`)
    : new AgentProtocolError('LOCATOR_NOT_FOUND', 'act locator matched no elements')
}

function validateAction(params: ActParams): void {
  if (['fill', 'type', 'press', 'select'].includes(params.action) && typeof params.value !== 'string') {
    throw new AgentProtocolError('INVALID_PARAMS', `${params.action} requires a string value`)
  }
  if (params.action === 'check' && params.value !== undefined && typeof params.value !== 'boolean') {
    throw new AgentProtocolError('INVALID_PARAMS', 'check value must be a boolean')
  }
}

function isActionable(match: InspectResult, action: ActParams['action']): boolean {
  if (match.states.includes('hidden')) return false
  return !['click', 'fill', 'type', 'press', 'select', 'check'].includes(action)
    || !match.states.includes('disabled')
}
