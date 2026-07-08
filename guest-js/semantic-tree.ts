import type { ExpectParams, ExpectResult, FindParams, InspectResult, KeyModifier } from '../protocol/types'

export interface SnapshotOptions {
  scope?: string
  mode?: 'compact' | 'verbose'
}

export interface SnapshotResult {
  text: string
  refs: Map<string, Element>
}

export interface ScrollOptions {
  x?: number
  y?: number
}

export interface DragOptions {
  toRef?: string
}

export interface PressOptions {
  modifiers?: KeyModifier[]
}

export type { InspectResult }

interface RenderState {
  nextRef: number
  refs: Map<string, Element>
  lines: string[]
  verbose: boolean
}

let currentRefs = new Map<string, Element>()

const REF_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'item',
  'link',
  'list',
  'menuitem',
  'navitem',
  'option',
  'radio',
  'switch',
  'tab',
  'textbox'
])

const STRUCTURAL_ROLES = new Set([
  'alert',
  'banner',
  'complementary',
  'contentinfo',
  'dialog',
  'form',
  'heading',
  'main',
  'navigation',
  'region',
  'search'
])

export function snapshotDocument(root: ParentNode = document, options: SnapshotOptions = {}): SnapshotResult {
  const target = options.scope ? root.querySelector(options.scope) : root
  if (!target) {
    return finish({ nextRef: 1, refs: new Map(), lines: [], verbose: options.mode === 'verbose' })
  }

  const start = target instanceof Document ? target.body : target
  const state: RenderState = {
    nextRef: 1,
    refs: new Map(),
    lines: [],
    verbose: options.mode === 'verbose'
  }

  if (start instanceof Element) {
    visitElement(start, 0, state, true)
  } else {
    visitChildren(start, 0, state)
  }

  return finish(state)
}

export function resolveRef(ref: string, refs: Map<string, Element> = currentRefs): Element {
  const normalized = normalizeRef(ref)
  const element = refs.get(normalized)
  if (!element) {
    throw new Error(`stale ref ${normalized}; run tree again`)
  }
  // A ref whose element was detached from the document since the snapshot would
  // otherwise "succeed" as a silent no-op; fail loudly so callers re-snapshot.
  if (!element.isConnected) {
    throw new Error(`stale ref ${normalized}; element is detached, run tree again`)
  }
  return element
}

export function currentRefRegistry(): Map<string, Element> {
  return new Map(currentRefs)
}

export function inspectRef(ref: string, refs: Map<string, Element> = currentRefs): InspectResult {
  const normalized = normalizeRef(ref)
  const element = resolveRef(normalized, refs)
  const role = semanticRole(element) ?? 'generic'
  return {
    ref: normalized,
    role,
    name: accessibleName(element, role),
    tagName: element.tagName.toLowerCase(),
    text: normalizeText(element.textContent ?? ''),
    ...controlValue(element),
    attributes: elementAttributes(element),
    states: stateFlags(element, role)
  }
}

export function findRefs(options: FindParams = {}, refs: Map<string, Element> = currentRefs): InspectResult[] {
  const limit = normalizedLimit(options.limit)
  if (limit === 0) {
    return []
  }

  const matches: InspectResult[] = []
  for (const ref of refs.keys()) {
    const inspected = inspectRef(ref, refs)
    if (!matchesFindOptions(inspected, options)) {
      continue
    }
    matches.push(inspected)
    if (matches.length >= limit) {
      break
    }
  }
  return matches
}

/**
 * Assert an already-located semantic match against the expectation params.
 * Throws with a specific message on mismatch; returns `{ ok, match }` on success.
 * Shared by the guest instrumentation and the static adapter.
 */
export function assertExpectation(
  match: InspectResult | undefined,
  options: ExpectParams
): ExpectResult {
  const present = options.present !== false
  if (!match) {
    if (present) {
      throw new Error(`expect: no element matched ${describeExpectLocator(options)}`)
    }
    return { ok: true }
  }
  if (!present) {
    throw new Error(`expect: element still present ${describeExpectLocator(options)}`)
  }
  if (options.value !== undefined && match.value !== options.value) {
    throw new Error(
      `expect: value ${JSON.stringify(match.value ?? null)} != ${JSON.stringify(options.value)}`
    )
  }
  if (options.hasState !== undefined && !match.states.includes(options.hasState)) {
    throw new Error(
      `expect: missing state "${options.hasState}"; has [${match.states.join(', ')}]`
    )
  }
  return { ok: true, match }
}

function describeExpectLocator(options: ExpectParams): string {
  const parts = [
    options.role ? `role=${options.role}` : null,
    options.name ? `name~=${options.name}` : null,
    options.text ? `text~=${options.text}` : null,
    options.scope ? `scope=${options.scope}` : null
  ].filter(Boolean)
  return parts.length ? parts.join(' ') : '(any)'
}

export function clickRef(ref: string): void {
  const element = resolveRef(ref)
  if (!('click' in element) || typeof element.click !== 'function') {
    throw new Error(`${normalizeRef(ref)} is not clickable`)
  }
  element.click()
}

export function hoverRef(ref: string): void {
  const element = resolveRef(ref)
  for (const eventName of ['mouseover', 'mouseenter', 'mousemove']) {
    element.dispatchEvent(new MouseEvent(eventName, { bubbles: eventName !== 'mouseenter', cancelable: true }))
  }
}

export function focusRef(ref: string): void {
  const normalized = normalizeRef(ref)
  const element = resolveRef(normalized)
  if (!('focus' in element) || typeof element.focus !== 'function') {
    throw new Error(`${normalized} is not focusable`)
  }
  element.focus()
}

export function blurRef(ref: string): void {
  const normalized = normalizeRef(ref)
  const element = resolveRef(normalized)
  if (!('blur' in element) || typeof element.blur !== 'function') {
    throw new Error(`${normalized} is not blurrable`)
  }
  element.blur()
}

export function scrollRef(ref: string, options: ScrollOptions = {}): void {
  const element = resolveRef(ref)
  element.scrollLeft += options.x ?? 0
  element.scrollTop += options.y ?? 0
  element.dispatchEvent(new Event('scroll', { bubbles: true }))
}

export function dragRef(ref: string, options: DragOptions = {}): void {
  const source = resolveRef(ref)
  const target = options.toRef ? resolveRef(options.toRef) : source
  dispatchMouseLike(source, 'mousedown')
  dispatchMouseLike(source, 'dragstart')
  dispatchMouseLike(target, 'dragenter')
  dispatchMouseLike(target, 'dragover')
  dispatchMouseLike(target, 'drop')
  dispatchMouseLike(source, 'dragend')
  dispatchMouseLike(source, 'mouseup')
}

export function checkRef(ref: string, checked = true): void {
  const normalized = normalizeRef(ref)
  const element = resolveRef(normalized)
  if (!(element instanceof HTMLInputElement) || (element.type !== 'checkbox' && element.type !== 'radio')) {
    throw new Error(`${normalized} is not checkable`)
  }
  if (element.type === 'radio' && !checked) {
    throw new Error(`radio ${normalized} cannot be unchecked directly`)
  }
  if (element.checked === checked) {
    return
  }
  setNativeChecked(element, checked)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

export function fillRef(ref: string, value: string): void {
  const element = resolveRef(ref)
  if (
    !(element instanceof HTMLInputElement) &&
    !(element instanceof HTMLTextAreaElement) &&
    !(element instanceof HTMLSelectElement)
  ) {
    throw new Error(`${normalizeRef(ref)} is not fillable`)
  }

  setNativeValue(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

export function typeRef(ref: string, text: string): void {
  const element = resolveRef(ref)
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
    throw new Error(`${normalizeRef(ref)} is not typeable`)
  }
  if (typeof element.focus === 'function') {
    element.focus()
  }
  // Append realistic per-character key events so apps with per-keystroke masking,
  // validation, or autocomplete observe input the way a user would produce it.
  for (const char of text) {
    const keyInit: KeyboardEventInit = { key: char, bubbles: true, cancelable: true }
    element.dispatchEvent(new KeyboardEvent('keydown', keyInit))
    element.dispatchEvent(new KeyboardEvent('keypress', keyInit))
    setNativeValue(element, element.value + char)
    element.dispatchEvent(
      new InputEvent('input', { bubbles: true, data: char, inputType: 'insertText' })
    )
    element.dispatchEvent(new KeyboardEvent('keyup', keyInit))
  }
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

export interface UploadFile {
  name: string
  type?: string
  /** Text content of the synthetic file (base64 is out of scope; agents upload small fixtures). */
  text?: string
}

export function uploadRef(ref: string, files: UploadFile[]): void {
  const element = resolveRef(ref)
  if (!(element instanceof HTMLInputElement) || element.type !== 'file') {
    throw new Error(`${normalizeRef(ref)} is not a file input`)
  }
  if (files.length === 0) {
    throw new Error('upload requires at least one file')
  }
  const view = element.ownerDocument.defaultView
  const FileCtor = view?.File ?? (typeof File !== 'undefined' ? File : undefined)
  if (!FileCtor) {
    throw new Error('File constructor unavailable in this environment')
  }
  const fileObjects = files.map(
    (file) => new FileCtor([file.text ?? ''], file.name, file.type ? { type: file.type } : undefined)
  )
  assignInputFiles(element, view, fileObjects)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

function assignInputFiles(
  input: HTMLInputElement,
  view: (Window & typeof globalThis) | null,
  files: File[]
): void {
  const DataTransferCtor = view?.DataTransfer ?? (typeof DataTransfer !== 'undefined' ? DataTransfer : undefined)
  if (DataTransferCtor) {
    try {
      const transfer = new DataTransferCtor()
      for (const file of files) {
        transfer.items.add(file)
      }
      input.files = transfer.files
      return
    } catch {
      // Fall through to the shadow-property path (e.g. jsdom without a writable
      // files setter).
    }
  }
  Object.defineProperty(input, 'files', { configurable: true, value: makeFileList(files) })
}

function makeFileList(files: File[]): FileList {
  const list = {
    length: files.length,
    item: (index: number): File | null => files[index] ?? null,
    [Symbol.iterator]: (): IterableIterator<File> => files[Symbol.iterator]()
  } as unknown as FileList & Record<number, File>
  files.forEach((file, index) => {
    list[index] = file
  })
  return list
}

export function selectRef(ref: string, value?: string): void {
  const element = resolveRef(ref)
  if (element instanceof HTMLOptionElement) {
    const select = element.parentElement
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error(`${normalizeRef(ref)} is not attached to a select control`)
    }
    setSelectValue(select, element.value)
    return
  }
  if (!(element instanceof HTMLSelectElement)) {
    throw new Error(`${normalizeRef(ref)} is not selectable`)
  }
  if (value === undefined || value.length === 0) {
    throw new Error('missing select value')
  }
  const option = findOption(element, value)
  if (!option) {
    throw new Error(`option not found for ${normalizeRef(ref)}: ${value}`)
  }
  setSelectValue(element, option.value)
}

export function pressKey(key: string, target: Element | Document = document, options: PressOptions = {}): void {
  const eventTarget =
    target instanceof Document ? target.activeElement ?? target.body ?? target.documentElement : target
  const keyboardOptions = {
    key,
    bubbles: true,
    cancelable: true,
    ...modifierFlags(options.modifiers)
  }
  eventTarget.dispatchEvent(new KeyboardEvent('keydown', keyboardOptions))
  eventTarget.dispatchEvent(new KeyboardEvent('keyup', keyboardOptions))
}

function modifierFlags(modifiers: KeyModifier[] = []): Pick<
  KeyboardEventInit,
  'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'
> {
  return {
    altKey: modifiers.includes('Alt'),
    ctrlKey: modifiers.includes('Control'),
    metaKey: modifiers.includes('Meta'),
    shiftKey: modifiers.includes('Shift')
  }
}

function dispatchMouseLike(element: Element, type: string): void {
  element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
}

function finish(state: RenderState): SnapshotResult {
  currentRefs = state.refs
  return {
    text: state.lines.join('\n'),
    refs: new Map(state.refs)
  }
}

function visitChildren(parent: ParentNode, depth: number, state: RenderState): void {
  for (const child of Array.from(parent.children)) {
    visitElement(child, depth, state, false)
  }
}

function visitElement(element: Element, depth: number, state: RenderState, isRoot: boolean): void {
  if (isInvisible(element) && !isFocused(element) && !isModalRelevant(element)) {
    return
  }

  const role = semanticRole(element)
  if (!role || !shouldInclude(element, role, isRoot)) {
    visitChildren(element, depth, state)
    return
  }

  appendLine(element, role, depth, state)

  if (role === 'list') {
    visitListItems(element, depth + 1, state)
    return
  }

  const childDepth = role === 'main' && depth === 0 ? 0 : depth + 1
  visitChildren(element, childDepth, state)
}

function visitListItems(list: Element, depth: number, state: RenderState): void {
  for (const child of Array.from(list.children)) {
    if (isInvisible(child) && !isFocused(child)) {
      continue
    }

    const role = semanticRole(child)
    if (role === 'item') {
      if (shouldIncludeItem(child)) {
        appendLine(child, role, depth, state)
        visitChildren(child, depth + 1, state)
      }
      continue
    }

    visitElement(child, depth, state, false)
  }
}

function appendLine(element: Element, role: string, depth: number, state: RenderState): void {
  const ref = shouldAssignRef(role) ? assignRef(element, state) : null
  const name = accessibleName(element, role)
  const count = role === 'list' ? listCount(element) : null
  const flags = stateFlags(element, role)
  const parts = [
    ref,
    role,
    name ? `"${escapeName(name)}"` : null,
    count == null ? null : String(count),
    ...flags,
    ...(state.verbose ? verboseAnnotations(element) : [])
  ].filter(Boolean)

  state.lines.push(`${'  '.repeat(depth)}${parts.join(' ')}`)
}

// Extra per-line detail rendered only in `verbose` mode. These are pure
// annotations on the same lines the compact tree emits, so ref numbering and
// tree shape stay identical between modes — a `@3` means the same element either
// way, and a caller can switch modes without invalidating refs.
function verboseAnnotations(element: Element): string[] {
  const extra: string[] = []
  const value = controlValue(element).value
  if (value !== undefined && value.length > 0) {
    extra.push(`value="${escapeName(truncate(value, 80))}"`)
  }
  const id = element.getAttribute('id')
  if (id) {
    extra.push(`#${id}`)
  }
  const testid = element.getAttribute('data-testid') ?? element.getAttribute('data-test-id')
  if (testid) {
    extra.push(`[testid=${testid}]`)
  }
  const type = element.getAttribute('type')
  if (type) {
    extra.push(`type=${type}`)
  }
  return extra
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function assignRef(element: Element, state: RenderState): string {
  const ref = `@${state.nextRef++}`
  state.refs.set(ref, element)
  return ref
}

function shouldAssignRef(role: string): boolean {
  return REF_ROLES.has(role)
}

function shouldInclude(element: Element, role: string, isRoot: boolean): boolean {
  if (role === 'item') {
    return shouldIncludeItem(element)
  }
  if (role === 'main') {
    return isRoot || Boolean(accessibleName(element, role))
  }
  if (role === 'list') {
    return listCount(element) > 0 || Boolean(accessibleName(element, role))
  }
  if (REF_ROLES.has(role)) {
    return true
  }
  if (STRUCTURAL_ROLES.has(role)) {
    return Boolean(accessibleName(element, role)) || isModalRelevant(element)
  }
  return false
}

function shouldIncludeItem(element: Element): boolean {
  return (
    hasTrueState(element, 'aria-selected') ||
    hasTrueState(element, 'aria-checked') ||
    isFocused(element) ||
    hasRelevantDescendant(element)
  )
}

function hasRelevantDescendant(element: Element): boolean {
  for (const child of Array.from(element.children)) {
    const role = semanticRole(child)
    if (role && role !== 'item' && REF_ROLES.has(role)) {
      return true
    }
    if (hasRelevantDescendant(child)) {
      return true
    }
  }
  return false
}

function semanticRole(element: Element): string | null {
  const explicitRole = element.getAttribute('role')?.trim()
  if (explicitRole) {
    return explicitRole.split(/\s+/)[0]
  }

  const tagName = element.tagName.toLowerCase()
  switch (tagName) {
    case 'a':
      return element.hasAttribute('href') ? 'link' : null
    case 'button':
      return 'button'
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading'
    case 'input':
      return inputRole(element as HTMLInputElement)
    case 'li':
      return 'item'
    case 'main':
      return 'main'
    case 'nav':
      return 'navigation'
    case 'ol':
    case 'ul':
      return 'list'
    case 'section':
      return element.hasAttribute('aria-label') || element.hasAttribute('aria-labelledby') ? 'region' : null
    case 'select':
      return 'combobox'
    case 'option':
      return 'option'
    case 'textarea':
      return 'textbox'
    default:
      return null
  }
}

function inputRole(input: HTMLInputElement): string | null {
  switch (input.type) {
    case 'button':
    case 'reset':
    case 'submit':
      return 'button'
    case 'checkbox':
      return 'checkbox'
    case 'radio':
      return 'radio'
    case 'hidden':
      return null
    default:
      return 'textbox'
  }
}

function accessibleName(element: Element, role: string): string {
  const labelled = labelledByText(element)
  const direct =
    element.getAttribute('aria-label') ??
    labelled ??
    element.getAttribute('alt') ??
    element.getAttribute('title') ??
    placeholderName(element)

  if (direct) {
    return normalizeText(direct)
  }

  if (role === 'textbox' && element instanceof HTMLInputElement) {
    const label = element.labels?.[0]
    if (label) {
      return normalizeText(ownText(label))
    }
  }

  if (role === 'item') {
    return normalizeText(ownText(element))
  }

  return normalizeText(element.textContent ?? '')
}

function labelledByText(element: Element): string | null {
  const ids = element.getAttribute('aria-labelledby')?.trim()
  if (!ids) {
    return null
  }

  return ids
    .split(/\s+/)
    .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '')
    .join(' ')
}

function placeholderName(element: Element): string | null {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.getAttribute('placeholder')
  }
  return null
}

function ownText(element: Element): string {
  let text = ''
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? ''
    }
  }
  return text
}

function listCount(element: Element): number {
  return Array.from(element.children).filter((child) => semanticRole(child) === 'item').length
}

function stateFlags(element: Element, role: string): string[] {
  const flags: string[] = []
  if (isSelected(element)) flags.push('selected')
  if (isChecked(element)) flags.push('checked')
  if (isDisabled(element)) flags.push('disabled')
  if (hasTrueState(element, 'aria-expanded')) flags.push('expanded')
  if (hasTrueState(element, 'aria-busy')) flags.push('busy')
  if (isInvisible(element)) flags.push('hidden')
  if (role === 'textbox' && isEmptyTextInput(element)) flags.push('empty')
  if (isFocused(element)) flags.push('focused')
  return flags
}

function controlValue(element: Element): { value?: string } {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return { value: element.value }
  }
  return {}
}

function elementAttributes(element: Element): Record<string, string> {
  return Object.fromEntries(
    Array.from(element.attributes)
      .map((attribute) => [attribute.name, attribute.value] as const)
      .sort(([left], [right]) => left.localeCompare(right))
  )
}

function isChecked(element: Element): boolean {
  return hasTrueState(element, 'aria-checked') || ('checked' in element && Boolean(element.checked))
}

function isSelected(element: Element): boolean {
  return hasTrueState(element, 'aria-selected') || (element instanceof HTMLOptionElement && element.selected)
}

function isDisabled(element: Element): boolean {
  return hasTrueState(element, 'aria-disabled') || ('disabled' in element && Boolean(element.disabled))
}

function isEmptyTextInput(element: Element): boolean {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value.length === 0
  }
  return false
}

function isFocused(element: Element): boolean {
  return element.ownerDocument.activeElement === element
}

function isInvisible(element: Element): boolean {
  return (
    element.hasAttribute('hidden') ||
    element.getAttribute('aria-hidden') === 'true' ||
    elementHasStyleValue(element, 'display', 'none') ||
    elementHasStyleValue(element, 'visibility', 'hidden')
  )
}

function isModalRelevant(element: Element): boolean {
  const role = element.getAttribute('role')
  return role === 'dialog' || role === 'alert' || element.getAttribute('aria-modal') === 'true'
}

function hasTrueState(element: Element, attribute: string): boolean {
  return element.getAttribute(attribute) === 'true'
}

function elementHasStyleValue(element: Element, property: string, value: string): boolean {
  const style = element.getAttribute('style')
  if (!style) {
    return false
  }
  return style
    .split(';')
    .some((declaration) => declaration.trim().toLowerCase() === `${property}: ${value}`)
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizedLimit(value: number | undefined): number {
  if (value === undefined) {
    return Number.POSITIVE_INFINITY
  }
  if (!Number.isFinite(value) || value <= 0) {
    return 0
  }
  return Math.floor(value)
}

function matchesFindOptions(inspected: InspectResult, options: FindParams): boolean {
  return (
    matchesOptionalText(inspected.role, options.role, 'exact') &&
    matchesOptionalText(inspected.name, options.name, 'contains') &&
    matchesOptionalText(inspected.text, options.text, 'contains')
  )
}

function matchesOptionalText(actual: string, expected: string | undefined, mode: 'contains' | 'exact'): boolean {
  if (expected === undefined || expected.length === 0) {
    return true
  }
  const normalizedActual = normalizeText(actual).toLowerCase()
  const normalizedExpected = normalizeText(expected).toLowerCase()
  return mode === 'exact' ? normalizedActual === normalizedExpected : normalizedActual.includes(normalizedExpected)
}

function escapeName(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function normalizeRef(ref: string): string {
  return ref.startsWith('@') ? ref : `@${ref}`
}

function setNativeValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string
): void {
  const prototype = Object.getPrototypeOf(element)
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
  if (descriptor?.set) {
    descriptor.set.call(element, value)
    return
  }
  element.value = value
}

function setNativeChecked(element: HTMLInputElement, checked: boolean): void {
  const prototype = Object.getPrototypeOf(element)
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'checked')
  if (descriptor?.set) {
    descriptor.set.call(element, checked)
    return
  }
  element.checked = checked
}

function findOption(select: HTMLSelectElement, value: string): HTMLOptionElement | undefined {
  return Array.from(select.options).find(
    (option) => option.value === value || normalizeText(option.textContent ?? '') === value
  )
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  setNativeValue(select, value)
  select.dispatchEvent(new Event('input', { bubbles: true }))
  select.dispatchEvent(new Event('change', { bubbles: true }))
}
