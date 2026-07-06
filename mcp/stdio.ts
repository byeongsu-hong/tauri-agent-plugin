import { createMcpRequestHandler, type McpRequestHandler } from './server'

export function serveMcpStdio(
  handler: McpRequestHandler = createMcpRequestHandler(),
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout
): void {
  let buffer = ''
  let queue = Promise.resolve()
  input.setEncoding('utf8')
  input.on('data', (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) {
        continue
      }
      queue = queue.then(() => respond(line, handler, output))
    }
  })
}

async function respond(
  line: string,
  handler: McpRequestHandler,
  output: NodeJS.WritableStream
): Promise<void> {
  const response = await handler(line)
  if (response !== undefined) {
    output.write(`${response}\n`)
  }
}
