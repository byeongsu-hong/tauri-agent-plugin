import { createMcpRequestHandler, type McpRequestHandler } from './server'

const MAX_REQUEST_LINE_BYTES = 4 * 1024 * 1024

export function serveMcpStdio(
  handler: McpRequestHandler = createMcpRequestHandler(),
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  maxRequestLineBytes = MAX_REQUEST_LINE_BYTES
): void {
  let buffer = ''
  let discardingOversizedLine = false
  input.setEncoding('utf8')
  input.on('data', (chunk) => {
    let text = chunk.toString()
    if (discardingOversizedLine) {
      const newline = text.indexOf('\n')
      if (newline === -1) return
      discardingOversizedLine = false
      text = text.slice(newline + 1)
    }
    buffer += text
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (Buffer.byteLength(line, 'utf8') + 1 > maxRequestLineBytes) {
        writeOversizedLineError(output)
        continue
      }
      if (!line.trim()) {
        continue
      }
      // Handle each request independently: a long-poll tool (wait/stream) must
      // not block every subsequent request behind it. Responses carry their
      // JSON-RPC id, so out-of-order completion is fine.
      void respond(line, handler, output)
    }
    if (Buffer.byteLength(buffer, 'utf8') > maxRequestLineBytes) {
      buffer = ''
      discardingOversizedLine = true
      writeOversizedLineError(output)
    }
  })
}

function writeOversizedLineError(output: NodeJS.WritableStream): void {
  output.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32700, message: 'MCP request line exceeds the maximum length' }
  })}\n`)
}

async function respond(
  line: string,
  handler: McpRequestHandler,
  output: NodeJS.WritableStream
): Promise<void> {
  try {
    const response = await handler(line)
    if (response !== undefined) {
      output.write(`${response}\n`)
    }
  } catch {
    // The handler already encodes protocol errors into responses; swallow any
    // unexpected throw rather than crashing the stdio server.
  }
}
