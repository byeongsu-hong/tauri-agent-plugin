/** JSON-RPC error with a stable code for retry and failure classification. */
export class AgentProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'AgentProtocolError'
  }
}
