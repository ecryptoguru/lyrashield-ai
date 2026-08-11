import { loadCredentials, removeCredentials } from "../credentials.js"
import { revokeOAuthCredentials } from "@lyrashield/credentials"
import type { Output } from "../output.js"

export async function handleLogout(_args: string[], output: Output): Promise<number> {
  const credentials = await loadCredentials()
  const revokedOAuth = Boolean(credentials?.oauthRefreshToken)
  if (credentials?.oauthRefreshToken) {
    try {
      await revokeOAuthCredentials(credentials)
    } catch (err) {
      output.error(err instanceof Error ? err.message : "OAuth revocation failed.")
      return 4
    }
  }
  await removeCredentials()
  output.log(
    revokedOAuth
      ? "Logged out. Stored credentials removed and OAuth access revoked."
      : "Logged out. Stored credentials removed."
  )
  return 0
}
