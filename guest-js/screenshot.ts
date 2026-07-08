import type { ScreenshotBackend, ScreenshotResult } from '../protocol/types'

export interface ScreenshotOptions {
  path?: string
  backend?: ScreenshotBackend
  /** Snapshot-local ref to scope the capture to a single element. */
  ref?: string
  /** Pre-resolved element to scope the capture to (used by {@link screenshotElement}). */
  element?: Element
}

export function screenshotDocument(
  root: Document = document,
  options: ScreenshotOptions = {}
): ScreenshotResult {
  if (options.element) {
    return screenshotElement(options.element, options)
  }
  const width = Math.max(
    root.documentElement.scrollWidth,
    root.body?.scrollWidth ?? 0,
    root.defaultView?.innerWidth ?? 0,
    1
  )
  const height = Math.max(
    root.documentElement.scrollHeight,
    root.body?.scrollHeight ?? 0,
    root.defaultView?.innerHeight ?? 0,
    1
  )
  return renderSvg(root.defaultView!, sanitizedClone(root.documentElement), width, height, options.path)
}

/** Capture a single element's subtree, sized to its bounding box. */
export function screenshotElement(element: Element, options: ScreenshotOptions = {}): ScreenshotResult {
  const view = element.ownerDocument.defaultView
  if (!view) {
    throw new Error('cannot screenshot a detached element')
  }
  const rect = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : undefined
  const htmlElement = element as HTMLElement
  const width = Math.max(Math.ceil(rect?.width || htmlElement.scrollWidth || 0), 1)
  const height = Math.max(Math.ceil(rect?.height || htmlElement.scrollHeight || 0), 1)
  return renderSvg(view, sanitizedClone(element), width, height, options.path)
}

function renderSvg(
  view: Window & typeof globalThis,
  node: Element,
  width: number,
  height: number,
  path?: string
): ScreenshotResult {
  const serializer = new view.XMLSerializer()
  const markup = serializer.serializeToString(node)
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<foreignObject width="100%" height="100%">${markup}</foreignObject>`,
    '</svg>'
  ].join('')

  return {
    ...(path ? { path } : {}),
    dataUrl: `data:image/svg+xml;base64,${base64EncodeUtf8(svg)}`,
    mime: 'image/svg+xml',
    width,
    height
  }
}

function sanitizedClone(source: Element): Element {
  const clone = source.cloneNode(true) as Element
  clone.querySelectorAll('script, noscript').forEach((element) => element.remove())
  for (const element of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
    for (const attribute of Array.from(element.attributes)) {
      if (isExecutableAttribute(attribute.name, attribute.value)) {
        element.removeAttribute(attribute.name)
      }
    }
  }
  return clone
}

function isExecutableAttribute(name: string, value: string): boolean {
  const normalizedName = name.toLowerCase()
  return normalizedName.startsWith('on') || value.trimStart().toLowerCase().startsWith('javascript:')
}

function base64EncodeUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  if (typeof btoa === 'function') {
    return btoa(binary)
  }
  return Buffer.from(binary, 'binary').toString('base64')
}
