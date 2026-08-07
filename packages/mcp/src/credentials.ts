/**
 * MCP server credential resolution.
 *
 * The read contract — file location, precedence, defaults, normalization — is
 * owned by `@lyrashield/credentials` and shared with the CLI so the two cannot
 * drift.
 *
 * This path deliberately tolerates an unreadable credentials file: the MCP
 * server runs inside someone's editor, and a corrupt file must not stop a valid
 * LYRASHIELD_API_KEY environment variable from working.
 */
import {
  CREDENTIALS_DIR,
  CREDENTIALS_FILE,
  resolveCredentials,
  type StoredCredentials,
} from "@lyrashield/credentials"

export { CREDENTIALS_DIR, CREDENTIALS_FILE }

export type Credentials = Pick<StoredCredentials, "apiKey" | "apiUrl">

export class NoApiKeyError extends Error {
  constructor() {
    super(
      "LYRASHIELD_API_KEY is not set and no credentials file was found. Run `lyrashield login` or set LYRASHIELD_API_KEY."
    )
    this.name = "NoApiKeyError"
  }
}

export async function resolveMcpCredentials(): Promise<{ apiKey: string; apiUrl: string }> {
  const { apiKey, apiUrl } = await resolveCredentials({ tolerateUnreadableFile: true })

  if (!apiKey) {
    throw new NoApiKeyError()
  }

  return { apiKey, apiUrl }
}
