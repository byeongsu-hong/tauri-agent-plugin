import type { InspectResult } from '../protocol/types'

export interface SnapshotOptions {
  scope?: string
  mode?: 'compact' | 'verbose'
}

export interface SnapshotResult {
  text: string
  refs: Map<string, Element>
}

export type { InspectResult }

interface RenderState {
  nextRef: number
  refs: Map<string, Element>
  lines: string[]
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
    return finish({ nextRef: 1, refs: new Map(), lines: [] })
  }

  const start = target instanceof Document ? target.body : target
  const state: RenderState = {
    nextRef: 1,
    refs: new Map(),
    lines: []
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

export function clickRef(ref: string): void {
  const element = resolveRef(ref)
  if (!('click' in element) || typeof element.click !== 'function') {
    throw new Error(`${normalizeRef(ref)} is not clickable`)
  }
  element.click()
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

export function pressKey(key: string, target: Element | Document = document): void {
  const eventTarget =
    target instanceof Document ? target.activeElement ?? target.body ?? target.documentElement : target
  eventTarget.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  eventTarget.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }))
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
    ...flags
  ].filter(Boolean)

  state.lines.push(`${'  '.repeat(depth)}${parts.join(' ')}`)
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
