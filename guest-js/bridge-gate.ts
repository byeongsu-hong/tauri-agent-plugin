let activeBridgeResponses = 0
let gate: { promise: Promise<void>; release: () => void } | undefined

export function deferDirectAgentInvokes(): () => void {
  if (!gate) {
    let releaseGate = () => {}
    const promise = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    gate = { promise, release: releaseGate }
  }

  activeBridgeResponses += 1
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    activeBridgeResponses -= 1
    if (activeBridgeResponses === 0) {
      const currentGate = gate
      gate = undefined
      currentGate?.release()
    }
  }
}

export async function waitForBridgeResponseTurn(): Promise<void> {
  await gate?.promise
}
