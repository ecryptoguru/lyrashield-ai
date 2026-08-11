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
  refreshOAuthCredentials,
  resolveCredentials,
  tryReadCredentialsFile,
  writeCredentialsFile,
  type StoredCredentials,
} from "@lyrashield/credentials"

export { CREDENTIALS_DIR, CREDENTIALS_FILE }

export type Credentials = Pick<StoredCredentials, "apiKey" | "oauthAccessToken" | "apiUrl">

export class NoApiKeyError extends Error {
  constructor() {
    super(
      "No LyraShield bearer credential was found. Run `lyrashield login --oauth`, set LYRASHIELD_API_KEY, or set LYRASHIELD_OAUTH_ACCESS_TOKEN."
    )
    this.name = "NoApiKeyError"
  }
}

export async function resolveMcpCredentials(): Promise<{ apiKey: string; apiUrl: string }> {
  const { apiKey, apiUrl, source } = await resolveCredentials({ tolerateUnreadableFile: true })

  if (!apiKey) {
    throw new NoApiKeyError()
  }

  // Environment credentials are deliberately immutable from this process. A
  // stored OAuth device credential can be refreshed and atomically rotated
  // before the long-lived stdio server starts.
  if (source === "file") {
    const stored = await tryReadCredentialsFile()
    if (stored?.oauthAccessToken && !stored.apiKey) {
      const refreshed = await refreshOAuthCredentials(stored)
      if (refreshed.oauthAccessToken !== stored.oauthAccessToken) {
        await writeCredentialsFile(refreshed)
      }
      if (refreshed.oauthAccessToken) return { apiKey: refreshed.oauthAccessToken, apiUrl }
    }
  }

  return { apiKey, apiUrl }
}
