import type {
  CookieParams,
  CookieResult,
  DialogEntry,
  DialogParams,
  DialogResult,
  InspectResult,
  LocationResult,
  StorageParams,
  StorageResult,
  WaitParams
} from '../protocol/types'

// Pure DOM-action helpers shared by the guest instrumentation and the static
// jsdom adapter. Each is parameterized by the document/store it acts on, so both
// surfaces stay behaviorally identical instead of drifting apart.

export function stateValue(state: Record<string, unknown>, key: string | undefined): unknown {
  return key === undefined ? state : state[key] ?? null
}

export function runtimeErrorMessage(event: Event): string {
  const errorEvent = event as ErrorEvent
  return errorLikeMessage(errorEvent.error) || errorEvent.message || 'Unknown runtime error'
}

export function errorLikeMessage(value: unknown): string {
  if (value instanceof Error) {
    return messageWithStack(value.message, value.stack) || value.name
  }
  if (typeof value === 'string') {
    return value
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const formatted = messageWithStack(
      typeof record.message === 'string' ? record.message : undefined,
      typeof record.stack === 'string' ? record.stack : undefined
    )
    if (formatted) {
      return formatted
    }
  }
  try {
    const serialized = JSON.stringify(value)
    if (serialized) {
      return serialized
    }
  } catch {
    // Fall through to String(value).
  }
  return String(value)
}

export function messageWithStack(message?: string, stack?: string): string {
  if (message && stack) {
    return stack.includes(message) ? stack : `${message}\n${stack}`
  }
  return stack || message || ''
}

export function storageArea(area: StorageParams['area']): 'local' | 'session' {
  return area === 'session' ? 'session' : 'local'
}

export function applyStorageAction(store: Storage, options: StorageParams): void {
  const action = options.action ?? 'get'
  switch (action) {
    case 'get':
      return
    case 'set':
      store.setItem(requiredStorageKey(options.key), requiredStorageValue(options.value))
      return
    case 'remove':
      store.removeItem(requiredStorageKey(options.key))
      return
    case 'clear':
      store.clear()
      return
  }
}

export function storageResult(store: Storage, area: 'local' | 'session', key?: string): StorageResult {
  const keys =
    key === undefined
      ? Array.from({ length: store.length }, (_, index) => store.key(index))
          .filter((value): value is string => value !== null)
          .sort()
      : store.getItem(key) === null
        ? []
        : [key]
  return {
    area,
    entries: keys.map((entryKey) => ({
      area,
      key: entryKey,
      value: store.getItem(entryKey) ?? ''
    }))
  }
}

export function applyCookieAction(document: Document, options: CookieParams): void {
  const action = options.action ?? 'get'
  switch (action) {
    case 'get':
      return
    case 'set':
      document.cookie = `${encodeURIComponent(requiredCookieName(options.name))}=${encodeURIComponent(requiredCookieValue(options.value))}; path=/`
      return
    case 'remove':
      expireCookie(document, requiredCookieName(options.name))
      return
    case 'clear':
      for (const entry of parseCookies(document.cookie)) {
        expireCookie(document, entry.name)
      }
      return
  }
}

export function cookieResult(document: Document, name?: string): CookieResult {
  const entries = parseCookies(document.cookie)
  return {
    entries: name === undefined ? entries : entries.filter((entry) => entry.name === name)
  }
}

export function parseCookies(cookie: string): CookieResult['entries'] {
  return cookie
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separatorIndex = part.indexOf('=')
      const name = separatorIndex === -1 ? part : part.slice(0, separatorIndex)
      const value = separatorIndex === -1 ? '' : part.slice(separatorIndex + 1)
      return { name: safeDecode(name), value: safeDecode(value) }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function expireCookie(document: Document, name: string): void {
  const encodedName = encodeURIComponent(name)
  for (const path of cookiePathCandidates(document.location.pathname)) {
    document.cookie = `${encodedName}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${path}`
  }
}

export function cookiePathCandidates(pathname: string): string[] {
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`
  const paths = new Set<string>(['/'])
  let current = ''
  for (const segment of normalizedPath.split('/').filter(Boolean)) {
    current = `${current}/${segment}`
    paths.add(current)
    paths.add(`${current}/`)
  }
  return [...paths].sort((a, b) => b.length - a.length)
}

export function requiredCookieName(name: string | undefined): string {
  if (!name) {
    throw new Error('cookie action requires name')
  }
  return name
}

export function requiredCookieValue(value: string | undefined): string {
  if (value === undefined) {
    throw new Error('cookie set requires value')
  }
  return value
}

export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function requiredStorageKey(key: string | undefined): string {
  if (!key) {
    throw new Error('storage action requires key')
  }
  return key
}

export function requiredStorageValue(value: string | undefined): string {
  if (value === undefined) {
    throw new Error('storage set requires value')
  }
  return value
}

export function locationResult(location: Location): LocationResult {
  return {
    href: location.href,
    origin: location.origin,
    pathname: location.pathname,
    search: location.search,
    hash: location.hash
  }
}

export function requiredLocationUrl(url: string | undefined): string {
  if (!url) {
    throw new Error('location action requires url')
  }
  return url
}

export function hasSemanticWaitFilter(options: WaitParams): boolean {
  return Boolean(options.scope || options.role || options.name)
}

export function waitTimeoutMessage(options: WaitParams, wantAbsent: boolean, semantic: boolean): string {
  if (wantAbsent) {
    return semantic
      ? 'wait timed out: semantic target still present'
      : `wait timed out: text still present: ${options.text}`
  }
  return semantic ? 'wait timed out for semantic target' : `wait timed out for text: ${options.text}`
}

/** A window-like target whose native dialog functions can be swapped. */
export interface DialogWindow {
  alert: (message?: string) => void
  confirm: (message?: string) => boolean
  prompt: (message?: string, defaultValue?: string) => string | null
}

/**
 * Non-blocking replacement for native `alert`/`confirm`/`prompt`, shared by the
 * guest instrumentation and the static jsdom adapter so both auto-handle dialogs
 * identically. Records what fired and answers per a configurable policy; the
 * originals are restored on {@link dispose}.
 */
export class DialogController {
  private dialogs: DialogEntry[] = []
  private policy: { accept: boolean; promptText?: string } = { accept: true }
  private originals?: Pick<DialogWindow, 'alert' | 'confirm' | 'prompt'>

  constructor(private readonly onEvent?: (entry: DialogEntry) => void) {}

  install(win: DialogWindow): void {
    if (this.originals) {
      return
    }
    this.originals = { alert: win.alert, confirm: win.confirm, prompt: win.prompt }
    win.alert = (message?: string): void => {
      this.record('alert', message, undefined, true)
    }
    win.confirm = (message?: string): boolean => {
      const accepted = this.policy.accept
      this.record('confirm', message, undefined, accepted)
      return accepted
    }
    win.prompt = (message?: string, defaultValue?: string): string | null => {
      const fallback = typeof defaultValue === 'string' ? defaultValue : undefined
      const response = this.policy.accept ? this.policy.promptText ?? fallback ?? '' : null
      this.record('prompt', message, fallback, response)
      return response
    }
  }

  dispose(win: DialogWindow): void {
    if (!this.originals) {
      return
    }
    win.alert = this.originals.alert
    win.confirm = this.originals.confirm
    win.prompt = this.originals.prompt
    this.originals = undefined
  }

  handle(params: DialogParams = {}): DialogResult {
    const action = params.action ?? 'get'
    if (action === 'set') {
      if (params.accept !== undefined) {
        this.policy.accept = params.accept
      }
      if (params.promptText !== undefined) {
        this.policy.promptText = params.promptText
      }
    } else if (action === 'clear') {
      this.dialogs = []
    }
    return {
      policy: { ...this.policy },
      dialogs: this.dialogs.map((entry) => ({ ...entry }))
    }
  }

  private record(
    type: DialogEntry['type'],
    message: unknown,
    defaultValue: string | undefined,
    response: string | boolean | null
  ): void {
    const entry: DialogEntry = {
      type,
      message: typeof message === 'string' ? message : String(message ?? ''),
      response,
      timestamp: new Date().toISOString()
    }
    if (defaultValue !== undefined) {
      entry.defaultValue = defaultValue
    }
    if (this.dialogs.length >= 1000) {
      this.dialogs.shift()
    }
    this.dialogs.push(entry)
    this.onEvent?.(entry)
  }
}

export function waitEventDetail(options: WaitParams, match: InspectResult): Record<string, unknown> {
  return {
    ...(options.text ? { text: options.text } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
    ...(options.role ? { role: options.role } : {}),
    ...(options.name ? { name: options.name } : {}),
    match
  }
}
