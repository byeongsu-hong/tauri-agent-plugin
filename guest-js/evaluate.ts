import type { EvalResult } from '../protocol/types'

export function evalResult(value: unknown): EvalResult {
  const type = evalType(value)
  const serialized = serializableValue(value)
  const text = resultText(value, serialized)
  return serialized === undefined ? { type, text } : { type, value: serialized, text }
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
