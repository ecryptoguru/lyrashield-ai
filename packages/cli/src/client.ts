import type { LyraShieldClient } from "@lyrashield/sdk"
import { getEffectiveCredentials } from "./credentials.js"
import { CLI_VERSION } from "./version.js"

export async function createClient(): Promise<LyraShieldClient> {
  const creds = await getEffectiveCredentials()
  if (!creds.apiKey) {
    throw new Error("No API key. Run: lyrashield login")
  }

  const { LyraShieldClient } = await import("@lyrashield/sdk")
  return new LyraShieldClient({
    apiKey: creds.apiKey,
    apiUrl: creds.apiUrl,
    userAgent: `lyrashield-cli/${CLI_VERSION}`,
  })
}
