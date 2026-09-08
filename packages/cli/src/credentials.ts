/* eslint-disable security/detect-non-literal-fs-filename */
/**
 * CLI credential storage.
 *
 * The read contract — file location, precedence, defaults, normalization — is
 * owned by `@lyrashield/credentials` and shared with the MCP server so the two
 * cannot drift. Only the write side (login/logout) is CLI-specific and lives
 * here.
 */
import { randomUUID } from "node:crypto"
import { unlink, access } from "node:fs/promises"
import {
  CREDENTIALS_DIR,
  CREDENTIALS_FILE,
  DEFAULT_API_URL,
  getEnvApiKey,
  getEnvApiUrl,
  getEnvOAuthAccessToken,
  readCredentialsFile,
  refreshOAuthCredentials,
  resolveCredentials,
  writeCredentialsFile,
  withCredentialsLock,
  hasCredentialsChanged,
  hasUsableOAuthAccessToken,
  OAuthRefreshError,
  type ResolvedCredentials,
  type StoredCredentials,
} from "@lyrashield/credentials"

export {
  CREDENTIALS_DIR,
  CREDENTIALS_FILE,
  DEFAULT_API_URL,
  getEnvApiKey,
  getEnvApiUrl,
  getEnvOAuthAccessToken,
}

export type Credentials = StoredCredentials
export type EffectiveCredentials = ResolvedCredentials

/**
 * Read the stored credentials. Returns undefined when no file exists; throws an
 * actionable error when the file exists but is unreadable or malformed.
 */
export async function loadCredentials(): Promise<Credentials | undefined> {
  return readCredentialsFile()
}

export async function saveCredentials(credentials: Credentials): Promise<void> {
  await withCredentialsLock(async () => {
    const withId: Credentials = { ...credentials, installId: credentials.installId || randomUUID() }
    await writeCredentialsFile(withId)
  })
}

export async function removeCredentials(): Promise<void> {
  await withCredentialsLock(async () => {
    try {
      await unlink(CREDENTIALS_FILE)
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return
      throw err
    }
  })
}

export async function credentialsFileExists(): Promise<boolean> {
  try {
    await access(CREDENTIALS_FILE)
    return true
  } catch {
    return false
  }
}

export async function getEffectiveCredentials(): Promise<EffectiveCredentials> {
  const resolved = await resolveCredentials()
  if (resolved.source !== "file" || resolved.credentialKind !== "oauth") return resolved

  return await withCredentialsLock(async () => {
    const stored = await loadCredentials()
    if (!stored?.oauthAccessToken && !stored?.oauthRefreshToken) {
      return resolveCredentials()
    }

    try {
      const refreshed = await refreshOAuthCredentials(stored)
      if (hasCredentialsChanged(stored, refreshed)) {
        const current = await loadCredentials()
        // Do not resurrect if file was removed or token was changed/revoked during in-flight refresh
        if (current && current.oauthRefreshToken === stored.oauthRefreshToken) {
          const withId: Credentials = {
            ...refreshed,
            installId: current.installId || refreshed.installId || randomUUID(),
            generation: (current.generation ?? 0) + 1,
          }
          await writeCredentialsFile(withId)
        }
      }
      return {
        ...resolved,
        apiKey: refreshed.oauthAccessToken ?? resolved.apiKey,
        apiUrl: refreshed.apiUrl ?? resolved.apiUrl,
        workspaceId: refreshed.workspaceId ?? resolved.workspaceId,
      }
    } catch (err) {
      if (
        err instanceof OAuthRefreshError &&
        err.isTransient &&
        hasUsableOAuthAccessToken(stored)
      ) {
        // Keep usable credentials during transient failures
        return resolved
      }
      throw err
    }
  })
}

export function requireApiKey(creds: EffectiveCredentials): string {
  if (!creds.apiKey) throw new Error("No API key. Run: lyrashield login")
  return creds.apiKey
}

export function requireWorkspace(creds: EffectiveCredentials): string {
  if (!creds.workspaceId) throw new Error("No workspace set. Run: lyrashield use <workspace>")
  return creds.workspaceId
}
