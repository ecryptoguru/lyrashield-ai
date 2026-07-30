import { randomUUID } from "node:crypto"
import { loadCredentials, saveCredentials } from "../credentials.js"
import type { Output } from "../output.js"

export async function handleUse(args: string[], output: Output): Promise<number> {
  const [workspaceId] = args
  if (!workspaceId) {
    output.error("usage: lyrashield use <workspace>")
    return 2
  }
  const existing = (await loadCredentials()) ?? { installId: randomUUID() }
  await saveCredentials({ ...existing, workspaceId })
  output.log(`Default workspace set to ${workspaceId}`)
  return 0
}
