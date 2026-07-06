import { describe, expect, it } from 'vitest'

import { screenshotDocument } from '../guest-js/screenshot'

describe('screenshotDocument', () => {
  it('serializes the visible DOM as a non-executable SVG screenshot fallback', () => {
    document.body.innerHTML = `
      <main aria-label="Ducktape" onclick="window.__clicked = true">
        <h1>Fixture</h1>
        <script>window.__shotExecuted = true</script>
      </main>
    `

    const screenshot = screenshotDocument(document)
    const svg = decodeDataUrl(screenshot.dataUrl ?? '')

    expect(screenshot.mime).toBe('image/svg+xml')
    expect(screenshot.width).toBeGreaterThan(0)
    expect(screenshot.height).toBeGreaterThan(0)
    expect(svg).toContain('Ducktape')
    expect(svg).toContain('Fixture')
    expect(svg).not.toContain('<script')
    expect(svg).not.toContain('onclick')
    expect(svg).not.toContain('__shotExecuted')
  })
})

function decodeDataUrl(dataUrl: string): string {
  const [, encoded = ''] = dataUrl.split(',', 2)
  return Buffer.from(encoded, 'base64').toString('utf8')
}
