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
  withCredentialsLock,
  hasCredentialsChanged,
  hasUsableOAuthAccessToken,
  OAuthRefreshError,
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

  if (source === "file") {
    const refreshed = await withCredentialsLock(async () => {
      const stored = await tryReadCredentialsFile()
      if ((stored?.oauthAccessToken || stored?.oauthRefreshToken) && !stored?.apiKey) {
        try {
          const next = await refreshOAuthCredentials(stored)
          if (hasCredentialsChanged(stored, next)) {
            const current = await tryReadCredentialsFile()
            if (current && current.oauthRefreshToken === stored.oauthRefreshToken) {
              await writeCredentialsFile({
                ...next,
                generation: (current.generation ?? 0) + 1,
              })
            }
          }
          return next
        } catch (err) {
          if (
            err instanceof OAuthRefreshError &&
            err.isTransient &&
            hasUsableOAuthAccessToken(stored)
          ) {
            return stored
          }
          throw err
        }
      }
      return stored
    })
    if (refreshed?.oauthAccessToken) return { apiKey: refreshed.oauthAccessToken, apiUrl }
  }

  if (!apiKey) {
    throw new NoApiKeyError()
  }

  return { apiKey, apiUrl }
}
