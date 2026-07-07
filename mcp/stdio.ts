import { createMcpRequestHandler, type McpRequestHandler } from './server'

export function serveMcpStdio(
  handler: McpRequestHandler = createMcpRequestHandler(),
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout
): void {
  let buffer = ''
  input.setEncoding('utf8')
  input.on('data', (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) {
        continue
      }
      // Handle each request independently: a long-poll tool (wait/stream) must
      // not block every subsequent request behind it. Responses carry their
      // JSON-RPC id, so out-of-order completion is fine.
      void respond(line, handler, output)
    }
  })
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
