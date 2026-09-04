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
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
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
export type CredentialKind = "api-key" | "oauth" | "none"

export interface ResolvedCredentials {
  apiKey: string | undefined
  credentialKind: CredentialKind
  apiUrl: string
  workspaceId: string | undefined
  installId: string | undefined
  source: CredentialSource
}

const OAUTH_REFRESH_SKEW_MS = 60_000

type OAuthRefreshOptions = {
  fetchFn?: typeof fetch
  now?: () => number
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

/**
 * Refresh an expiring OAuth device credential without changing API-key or
 * environment-variable precedence. Better Auth rotates refresh tokens, so the
 * returned credential must replace the stored value before the next refresh.
 */
export async function refreshOAuthCredentials(
  credentials: StoredCredentials,
  { fetchFn = fetch, now = Date.now }: OAuthRefreshOptions = {}
): Promise<StoredCredentials> {
  const expiresAt = credentials.oauthExpiresAt ? Date.parse(credentials.oauthExpiresAt) : NaN
  if (
    credentials.oauthAccessToken &&
    (!Number.isFinite(expiresAt) || expiresAt > now() + OAUTH_REFRESH_SKEW_MS)
  ) {
    return credentials
  }
  if (!credentials.oauthRefreshToken) return credentials

  let response: Response
  try {
    response = await fetchFn(
      `${(credentials.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "")}/api/auth/oauth2/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: credentials.oauthRefreshToken,
          client_id: "lyrashield-cli",
        }).toString(),
      }
    )
  } catch {
    throw new Error("OAuth token refresh failed. Run `lyrashield login --oauth` to reconnect.")
  }

  const token = (await response.json().catch(() => null)) as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
  } | null
  if (!response.ok || typeof token?.access_token !== "string" || !token.access_token) {
    throw new Error(
      "OAuth token refresh was rejected. Run `lyrashield login --oauth` to reconnect."
    )
  }

  const expiresIn =
    typeof token.expires_in === "number" && token.expires_in > 0 ? token.expires_in : undefined
  return normalizeCredentials({
    ...credentials,
    oauthAccessToken: token.access_token,
    oauthRefreshToken:
      typeof token.refresh_token === "string" && token.refresh_token
        ? token.refresh_token
        : credentials.oauthRefreshToken,
    oauthExpiresAt: expiresIn ? new Date(now() + expiresIn * 1000).toISOString() : undefined,
  })
}

/** Revoke a device-login refresh token before removing it from local storage. */
export async function revokeOAuthCredentials(
  credentials: StoredCredentials,
  { fetchFn = fetch }: Pick<OAuthRefreshOptions, "fetchFn"> = {}
): Promise<void> {
  if (!credentials.oauthRefreshToken) return

  let response: Response
  try {
    response = await fetchFn(
      `${(credentials.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "")}/api/auth/oauth2/revoke`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: credentials.oauthRefreshToken,
          token_type_hint: "refresh_token",
          client_id: "lyrashield-cli",
        }).toString(),
      }
    )
  } catch {
    throw new Error(
      "OAuth revocation failed. Check your connection and try `lyrashield logout` again."
    )
  }
  if (!response.ok) {
    throw new Error(
      "OAuth revocation was rejected. Run `lyrashield logout` again or revoke the connection in the dashboard."
    )
  }
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

/** Persist shared CLI/MCP credentials atomically with user-only permissions. */
export async function writeCredentialsFile(credentials: StoredCredentials): Promise<void> {
  await mkdir(CREDENTIALS_DIR, { recursive: true, mode: 0o700 })
  const temporary = `${CREDENTIALS_FILE}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(normalizeCredentials(credentials), null, 2), {
      mode: 0o600,
      flag: "wx",
    })
    await rename(temporary, CREDENTIALS_FILE)
  } finally {
    await rm(temporary, { force: true })
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
  const envKey = getEnvApiKey() || undefined
  const envOAuth = getEnvOAuthAccessToken() || undefined
  const envUrl = getEnvApiUrl() || undefined
  const stored = options.tolerateUnreadableFile
    ? await tryReadCredentialsFile()
    : await readCredentialsFile()

  return {
    apiKey: envKey ?? envOAuth ?? stored?.apiKey ?? stored?.oauthAccessToken,
    credentialKind: envKey
      ? "api-key"
      : envOAuth
        ? "oauth"
        : stored?.apiKey
          ? "api-key"
          : stored?.oauthAccessToken
            ? "oauth"
            : "none",
    apiUrl: envUrl ?? stored?.apiUrl ?? DEFAULT_API_URL,
    workspaceId: stored?.workspaceId,
    installId: stored?.installId,
    // `source` identifies the bearer credential, not an independent API URL
    // override. Consumers use it to decide whether an OAuth credential may be
    // refreshed and persisted.
    source: envKey || envOAuth ? "env" : stored ? "file" : "none",
  }
}
