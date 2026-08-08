/* eslint-disable security/detect-non-literal-fs-filename */
/**
 * Single source of truth for LyraShield credential storage.
 *
 * The CLI (`lyrashield`) and the MCP server (`@lyrashield/mcp`) both read the
 * same `~/.lyrashield/credentials.json` and both apply "env wins over file"
 * precedence. Before this module they each defined that contract independently
 * and had already drifted, so a change to the file location, the precedence
 * order, or the default API URL had to be made twice or the two would silently
 * disagree.
 *
 * Both consumers bundle this package (`noExternal: [/^@lyrashield\//]` in their
 * tsup configs), so it stays private and is never published on its own.
 *
 * Deliberate difference preserved: the CLI surfaces a corrupt credentials file
 * as an error (the user needs to fix it), while the MCP server falls back to
 * environment variables so a broken file cannot take down a working env-var
 * setup. Both behaviours live here as explicit, named functions rather than
 * being re-implemented per package.
 */
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

export const CREDENTIALS_DIR = path.join(homedir(), ".lyrashield")
export const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, "credentials.json")

/** Fallback when neither the environment nor the credentials file names an API URL. */
export const DEFAULT_API_URL = "https://app.lyrashieldai.com"

export interface StoredCredentials {
  apiKey?: string
  oauthAccessToken?: string
  oauthRefreshToken?: string
  oauthExpiresAt?: string
  apiUrl?: string
  workspaceId?: string
  installId: string
}

export type CredentialSource = "env" | "file" | "none"

export interface ResolvedCredentials {
  apiKey: string | undefined
  apiUrl: string
  workspaceId: string | undefined
  installId: string | undefined
  source: CredentialSource
}

export function getEnvApiKey(): string | undefined {
  return process.env.LYRASHIELD_API_KEY
}

export function getEnvApiUrl(): string | undefined {
  return process.env.LYRASHIELD_API_URL
}

export function getEnvOAuthAccessToken(): string | undefined {
  return process.env.LYRASHIELD_OAUTH_ACCESS_TOKEN
}

/**
 * Normalize a parsed credentials object to the known field set, trimming string
 * values and dropping unknown keys. A hand-edited or partially-written file can
 * carry stale or extra fields; this keeps the in-memory shape stable and stops
 * that drift persisting across save/load cycles.
 */
export function normalizeCredentials(parsed: Partial<StoredCredentials>): StoredCredentials {
  const normalized: StoredCredentials = {
    installId: parsed.installId || randomUUID(),
  }
  if (typeof parsed.apiKey === "string" && parsed.apiKey.trim()) {
    normalized.apiKey = parsed.apiKey.trim()
  }
  for (const field of ["oauthAccessToken", "oauthRefreshToken", "oauthExpiresAt"] as const) {
    const value = parsed[field]
    if (typeof value === "string" && value.trim()) normalized[field] = value.trim()
  }
  if (typeof parsed.apiUrl === "string" && parsed.apiUrl.trim()) {
    normalized.apiUrl = parsed.apiUrl.trim()
  }
  if (typeof parsed.workspaceId === "string" && parsed.workspaceId.trim()) {
    normalized.workspaceId = parsed.workspaceId.trim()
  }
  return normalized
}

function isNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT")
}

/**
 * Read and normalize the credentials file.
 *
 * Returns `undefined` when the file does not exist. Throws an actionable error
 * when it exists but cannot be read or parsed — the raw underlying error is
 * deliberately not interpolated, since it leaks absolute paths and platform
 * errno noise without telling the user what to do about it.
 */
export async function readCredentialsFile(): Promise<StoredCredentials | undefined> {
  let raw: string
  try {
    raw = await readFile(CREDENTIALS_FILE, "utf-8")
  } catch (err) {
    if (isNotFound(err)) return undefined
    throw new Error(
      `Could not read ${CREDENTIALS_FILE}. Check the file's permissions, or delete it and run: lyrashield login`
    )
  }

  try {
    return normalizeCredentials(JSON.parse(raw) as Partial<StoredCredentials>)
  } catch {
    throw new Error(`${CREDENTIALS_FILE} is not valid JSON. Delete it and run: lyrashield login`)
  }
}

/**
 * Same as {@link readCredentialsFile} but never throws.
 *
 * Used by the MCP server, where a corrupt file must not prevent a valid
 * `LYRASHIELD_API_KEY` environment variable from working.
 */
export async function tryReadCredentialsFile(): Promise<StoredCredentials | undefined> {
  try {
    return await readCredentialsFile()
  } catch {
    return undefined
  }
}

/**
 * Resolve effective credentials with environment variables taking precedence
 * over the stored file.
 *
 * `tolerateUnreadableFile` selects which read behaviour to use; see the note at
 * the top of this module.
 */
export async function resolveCredentials(
  options: { tolerateUnreadableFile?: boolean } = {}
): Promise<ResolvedCredentials> {
  const envKey = getEnvApiKey()
  const envOAuth = getEnvOAuthAccessToken()
  const envUrl = getEnvApiUrl()
  const stored = options.tolerateUnreadableFile
    ? await tryReadCredentialsFile()
    : await readCredentialsFile()

  return {
    apiKey: envKey ?? envOAuth ?? stored?.apiKey ?? stored?.oauthAccessToken,
    apiUrl: envUrl ?? stored?.apiUrl ?? DEFAULT_API_URL,
    workspaceId: stored?.workspaceId,
    installId: stored?.installId,
    source: envKey || envOAuth || envUrl ? "env" : stored ? "file" : "none",
  }
}
