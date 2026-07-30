import type { Output } from "../output.js"

export async function handleRules(args: string[], output: Output): Promise<number> {
  if (args[0] === "add") {
    const [, agentId] = args
    if (!agentId) {
      output.error("usage: lyrashield rules add <agent>")
      return 2
    }
    output.error(`rules add <agent> is stubbed for PR2. Agent: ${agentId}`)
    return 1
  }
  output.error("usage: lyrashield rules add <agent>")
  return 2
}
