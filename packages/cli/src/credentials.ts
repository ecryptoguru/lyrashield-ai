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
import { mkdir, writeFile, unlink, chmod, access, rename } from "node:fs/promises"
import {
  CREDENTIALS_DIR,
  CREDENTIALS_FILE,
  getEnvApiKey,
  getEnvApiUrl,
  getEnvOAuthAccessToken,
  readCredentialsFile,
  resolveCredentials,
  type ResolvedCredentials,
  type StoredCredentials,
} from "@lyrashield/credentials"

export { CREDENTIALS_DIR, CREDENTIALS_FILE, getEnvApiKey, getEnvApiUrl, getEnvOAuthAccessToken }

export type Credentials = StoredCredentials
export type EffectiveCredentials = ResolvedCredentials

async function ensureDir(): Promise<void> {
  await mkdir(CREDENTIALS_DIR, { recursive: true, mode: 0o700 })
}

async function setFileMode(file: string, mode: number): Promise<void> {
  try {
    await chmod(file, mode)
  } catch {
    // ignore platforms without chmod semantics
  }
}

/**
 * Read the stored credentials. Returns undefined when no file exists; throws an
 * actionable error when the file exists but is unreadable or malformed.
 */
export async function loadCredentials(): Promise<Credentials | undefined> {
  return readCredentialsFile()
}

export async function saveCredentials(credentials: Credentials): Promise<void> {
  await ensureDir()
  const withId: Credentials = { ...credentials, installId: credentials.installId || randomUUID() }
  const tmp = `${CREDENTIALS_FILE}.tmp`
  await writeFile(tmp, JSON.stringify(withId, null, 2), { mode: 0o600 })
  await setFileMode(tmp, 0o600)
  await rename(tmp, CREDENTIALS_FILE)
}

export async function removeCredentials(): Promise<void> {
  try {
    await unlink(CREDENTIALS_FILE)
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return
    throw err
  }
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
  return resolveCredentials()
}

export function requireApiKey(creds: EffectiveCredentials): string {
  if (!creds.apiKey) throw new Error("No API key. Run: lyrashield login")
  return creds.apiKey
}

export function requireWorkspace(creds: EffectiveCredentials): string {
  if (!creds.workspaceId) throw new Error("No workspace set. Run: lyrashield use <workspace>")
  return creds.workspaceId
}
