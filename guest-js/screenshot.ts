import type { ScreenshotResult } from '../protocol/types'

export interface ScreenshotOptions {
  path?: string
}

export function screenshotDocument(
  root: Document = document,
  options: ScreenshotOptions = {}
): ScreenshotResult {
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
  const serializer = new root.defaultView!.XMLSerializer()
  const markup = serializer.serializeToString(sanitizedDocumentElement(root))
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<foreignObject width="100%" height="100%">${markup}</foreignObject>`,
    '</svg>'
  ].join('')

  return {
    ...(options.path ? { path: options.path } : {}),
    dataUrl: `data:image/svg+xml;base64,${base64EncodeUtf8(svg)}`,
    mime: 'image/svg+xml',
    width,
    height
  }
}

function sanitizedDocumentElement(root: Document): Element {
  const clone = root.documentElement.cloneNode(true) as Element
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
