import type { EvalResult } from '../protocol/types'

export function evalResult(value: unknown): EvalResult {
  const type = evalType(value)
  const serialized = serializableValue(value)
  const text = resultText(value, serialized)
  return serialized === undefined ? { type, text } : { type, value: serialized, text }
}

/**
 * Await a thenable result before serializing, so evaluating async code returns
 * the resolved value (Playwright semantics) instead of an opaque `{}`.
 */
export async function evalResultAsync(value: unknown): Promise<EvalResult> {
  return evalResult(isThenable(value) ? await value : value)
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function evalType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function serializableValue(value: unknown): unknown | undefined {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined
  }
  if (typeof value === 'bigint') {
    return undefined
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return undefined
  }

  try {
    const json = JSON.stringify(value)
    return json === undefined ? undefined : JSON.parse(json)
  } catch {
    return undefined
  }
}

function resultText(value: unknown, serialized: unknown | undefined): string {
  if (typeof value === 'string') {
    return value
  }
  if (serialized !== undefined) {
    return typeof serialized === 'object' ? JSON.stringify(serialized) : String(serialized)
  }
  return String(value)
}
