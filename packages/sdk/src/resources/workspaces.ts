import type { LyraShieldClient } from "../client"

export function listWorkspaces(client: LyraShieldClient) {
  return client.request("GET", "/workspaces")
}
