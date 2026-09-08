/* eslint-disable security/detect-non-literal-fs-filename */
/**
 * Single source of truth for LyraShield credential storage.
 *
 * The CLI (`lyrashield`) and the MCP server (`@lyrashield/mcp`) both read the
 * same `~/.lyrashield/credentials.json` and both apply "env wins over file"
 * precedence.
 */
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

export const CREDENTIALS_DIR = path.join(homedir(), ".lyrashield")
export const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, "credentials.json")
export const CREDENTIALS_LOCK_FILE = path.join(CREDENTIALS_DIR, "credentials.lock")

/** Fallback when neither the environment nor the credentials file names an API URL. */
export const DEFAULT_API_URL = "https://app.lyrashieldai.com"

export interface CredentialProfile {
  apiKey?: string
  oauthAccessToken?: string
  oauthRefreshToken?: string
  oauthExpiresAt?: string
  apiUrl?: string
  workspaceId?: string
  clientId?: string
  connectionId?: string
  issuer?: string
  resource?: string
  generation?: number
  updatedAt?: string
}

export interface StoredCredentials extends CredentialProfile {
  version?: number
  defaultProfile?: string
  profiles?: Record<string, CredentialProfile>
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
  originMismatch?: boolean
}

export class OAuthRefreshError extends Error {
  readonly isTransient: boolean
  readonly permanent: boolean

  constructor(message: string, { isTransient = false }: { isTransient?: boolean } = {}) {
    super(message)
    this.name = "OAuthRefreshError"
    this.isTransient = isTransient
    this.permanent = !isTransient
  }
}

const OAUTH_REFRESH_SKEW_MS = 60_000
const DEFAULT_LOCK_TIMEOUT_MS = 5000
const STALE_LOCK_MS = 8000
const RETRY_INTERVAL_MS = 50

type OAuthRefreshOptions = {
  fetchFn?: typeof fetch
  now?: () => number
  retries?: number
}

function oauthEndpoint(credentials: StoredCredentials, action: "token" | "revoke"): string {
  const base = (credentials.issuer ?? credentials.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "")
  return base.endsWith("/api/auth")
    ? `${base}/oauth2/${action}`
    : `${base}/api/auth/oauth2/${action}`
}

export function hasUsableOAuthAccessToken(
  credentials: Pick<StoredCredentials, "oauthAccessToken" | "oauthExpiresAt">,
  now = Date.now()
): boolean {
  if (!credentials.oauthAccessToken) return false
  if (!credentials.oauthExpiresAt) return true
  const expiresAt = Date.parse(credentials.oauthExpiresAt)
  return Number.isFinite(expiresAt) && expiresAt > now
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

export function normalizeOrigin(urlStr: string): string {
  try {
    const parsed = new URL(urlStr)
    return parsed.origin.toLowerCase()
  } catch {
    return urlStr.replace(/\/+$/, "").toLowerCase()
  }
}

export function normalizeProfile(parsed: Partial<CredentialProfile>): CredentialProfile {
  const normalized: CredentialProfile = {}
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
  for (const field of ["clientId", "connectionId", "issuer", "resource", "updatedAt"] as const) {
    const value = parsed[field]
    if (typeof value === "string" && value.trim()) normalized[field] = value.trim()
  }
  if (typeof parsed.generation === "number" && Number.isFinite(parsed.generation)) {
    normalized.generation = parsed.generation
  }
  return normalized
}

export function normalizeCredentials(parsed: Partial<StoredCredentials>): StoredCredentials {
  const rootProfile = normalizeProfile(parsed)
  const installId =
    typeof parsed.installId === "string" && parsed.installId.trim()
      ? parsed.installId.trim()
      : randomUUID()

  const normalized: StoredCredentials = {
    ...rootProfile,
    installId,
  }

  if (typeof parsed.version === "number") {
    normalized.version = parsed.version
  }
  if (typeof parsed.defaultProfile === "string" && parsed.defaultProfile.trim()) {
    normalized.defaultProfile = parsed.defaultProfile.trim()
  }
  if (parsed.profiles && typeof parsed.profiles === "object") {
    const profiles: Record<string, CredentialProfile> = {}
    for (const [key, prof] of Object.entries(parsed.profiles)) {
      if (prof && typeof prof === "object") {
        profiles[key] = normalizeProfile(prof)
      }
    }
    normalized.profiles = profiles
  }

  return normalized
}

export function hasCredentialsChanged(
  prev: StoredCredentials | undefined,
  next: StoredCredentials
): boolean {
  if (!prev) return true
  const fields = [
    "apiKey",
    "oauthAccessToken",
    "oauthRefreshToken",
    "oauthExpiresAt",
    "apiUrl",
    "workspaceId",
    "clientId",
    "connectionId",
    "generation",
  ] as const
  for (const f of fields) {
    if (prev[f] !== next[f]) return true
  }

  const prevProfiles = prev.profiles ?? {}
  const nextProfiles = next.profiles ?? {}
  const prevKeys = Object.keys(prevProfiles)
  const nextKeys = Object.keys(nextProfiles)
  if (prevKeys.length !== nextKeys.length) return true
  for (const k of nextKeys) {
    const pP = prevProfiles[k]
    const nP = nextProfiles[k]
    if (!pP || !nP) return true
    for (const f of fields) {
      if (pP[f] !== nP[f]) return true
    }
  }
  return false
}

export async function withCredentialsLock<T>(
  fn: () => Promise<T>,
  options: { timeoutMs?: number; staleMs?: number } = {}
): Promise<T> {
  await mkdir(CREDENTIALS_DIR, { recursive: true, mode: 0o700 })
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  const staleMs = options.staleMs ?? STALE_LOCK_MS
  const start = Date.now()
  const ownerId = randomUUID()

  while (true) {
    try {
      const lockData = JSON.stringify({ ownerId, pid: process.pid, createdAt: Date.now() })
      await writeFile(CREDENTIALS_LOCK_FILE, lockData, { flag: "wx", mode: 0o600 })
      break
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === "EEXIST") {
        try {
          const content = await readFile(CREDENTIALS_LOCK_FILE, "utf-8")
          const parsed = JSON.parse(content) as {
            ownerId?: string
            pid?: number
            createdAt?: number
          }
          const isStale =
            typeof parsed.createdAt === "number" && Date.now() - parsed.createdAt > staleMs
          let processDead = false
          if (typeof parsed.pid === "number" && parsed.pid > 0 && process.platform !== "win32") {
            try {
              process.kill(parsed.pid, 0)
            } catch (killErr: unknown) {
              if ((killErr as { code?: string })?.code === "ESRCH") {
                processDead = true
              }
            }
          }
          const hasOwner = typeof parsed.ownerId === "string" && parsed.ownerId.length > 0
          const canRecover = processDead || (isStale && (!hasOwner || process.platform === "win32"))
          if (canRecover) {
            await rm(CREDENTIALS_LOCK_FILE, { force: true }).catch(() => {})
            continue
          }
        } catch {
          const lockStat = await stat(CREDENTIALS_LOCK_FILE).catch(() => null)
          if (lockStat && Date.now() - lockStat.mtimeMs > staleMs) {
            await rm(CREDENTIALS_LOCK_FILE, { force: true }).catch(() => {})
            continue
          }
        }

        if (Date.now() - start > timeoutMs) {
          throw new Error(
            `Timed out waiting for credentials lock (${CREDENTIALS_LOCK_FILE}) after ${timeoutMs}ms.`
          )
        }
        await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS))
      } else {
        throw err
      }
    }
  }

  try {
    return await fn()
  } finally {
    try {
      const current = JSON.parse(await readFile(CREDENTIALS_LOCK_FILE, "utf-8")) as {
        ownerId?: string
      }
      if (current.ownerId === ownerId) {
        await rm(CREDENTIALS_LOCK_FILE, { force: true })
      }
    } catch {
      // Missing/replaced lock belongs to no removable owner here.
    }
  }
}

export async function refreshOAuthCredentials(
  credentials: StoredCredentials,
  { fetchFn = fetch, now = Date.now, retries = 2 }: OAuthRefreshOptions = {}
): Promise<StoredCredentials> {
  const expiresAt = credentials.oauthExpiresAt ? Date.parse(credentials.oauthExpiresAt) : NaN
  if (
    credentials.oauthAccessToken &&
    Number.isFinite(expiresAt) &&
    expiresAt > now() + OAUTH_REFRESH_SKEW_MS
  ) {
    return credentials
  }
  if (!credentials.oauthRefreshToken) return credentials

  let response: Response | undefined
  const maxAttempts = Math.max(1, retries + 1)

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      response = await fetchFn(oauthEndpoint(credentials, "token"), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: credentials.oauthRefreshToken,
          client_id: credentials.clientId ?? "lyrashield-cli",
          ...(credentials.resource ? { resource: credentials.resource } : {}),
        }).toString(),
      })
      if (response.status === 429 || response.status >= 500) {
        if (attempt < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, Math.min(100 * Math.pow(2, attempt), 1000)))
          continue
        }
      }
      break
    } catch {
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, Math.min(100 * Math.pow(2, attempt), 1000)))
        continue
      }
    }
  }

  if (!response) {
    throw new OAuthRefreshError(
      "OAuth token refresh failed due to a transient network error. Run `lyrashield login --oauth` if the issue persists.",
      { isTransient: true }
    )
  }

  if (response.status === 429 || response.status >= 500) {
    throw new OAuthRefreshError(
      `OAuth provider returned transient error HTTP ${response.status}. Retaining current credentials.`,
      { isTransient: true }
    )
  }

  const token = (await response.json().catch(() => null)) as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
    error?: unknown
  } | null

  if (!response.ok || (typeof token?.access_token !== "string" && !token?.refresh_token)) {
    const isInvalidGrant =
      token?.error === "invalid_grant" || response.status === 400 || response.status === 401
    throw new OAuthRefreshError(
      "OAuth token refresh was rejected. Run `lyrashield login --oauth` to reconnect.",
      { isTransient: !isInvalidGrant }
    )
  }

  const expiresIn =
    typeof token.expires_in === "number" && token.expires_in > 0 ? token.expires_in : undefined
  const nextAccessToken =
    typeof token.access_token === "string" && token.access_token
      ? token.access_token
      : credentials.oauthAccessToken
  const nextRefreshToken =
    typeof token.refresh_token === "string" && token.refresh_token
      ? token.refresh_token
      : credentials.oauthRefreshToken

  return normalizeCredentials({
    ...credentials,
    oauthAccessToken: nextAccessToken,
    oauthRefreshToken: nextRefreshToken,
    oauthExpiresAt: expiresIn
      ? new Date(now() + expiresIn * 1000).toISOString()
      : credentials.oauthExpiresAt,
    updatedAt: new Date(now()).toISOString(),
  })
}

export async function revokeOAuthCredentials(
  credentials: StoredCredentials,
  { fetchFn = fetch }: Pick<OAuthRefreshOptions, "fetchFn"> = {}
): Promise<void> {
  if (!credentials.oauthRefreshToken) return

  let response: Response
  try {
    response = await fetchFn(oauthEndpoint(credentials, "revoke"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: credentials.oauthRefreshToken,
        token_type_hint: "refresh_token",
        client_id: credentials.clientId ?? "lyrashield-cli",
      }).toString(),
    })
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
    await rm(temporary, { force: true }).catch(() => {})
  }
}

export async function tryReadCredentialsFile(): Promise<StoredCredentials | undefined> {
  try {
    return await readCredentialsFile()
  } catch {
    return undefined
  }
}

export async function resolveCredentials(
  options: { tolerateUnreadableFile?: boolean } = {}
): Promise<ResolvedCredentials> {
  const envKey = getEnvApiKey() || undefined
  const envOAuth = getEnvOAuthAccessToken() || undefined
  const envUrl = getEnvApiUrl() || undefined
  const stored = options.tolerateUnreadableFile
    ? await tryReadCredentialsFile()
    : await readCredentialsFile()

  if (envKey || envOAuth) {
    return {
      apiKey: envKey ?? envOAuth,
      credentialKind: envKey ? "api-key" : "oauth",
      apiUrl: envUrl ?? stored?.apiUrl ?? DEFAULT_API_URL,
      workspaceId: stored?.workspaceId,
      installId: stored?.installId,
      source: "env",
    }
  }

  if (envUrl && stored) {
    const envOrigin = normalizeOrigin(envUrl)
    let matchingProfile: CredentialProfile | undefined = undefined
    if (stored.profiles) {
      for (const prof of Object.values(stored.profiles)) {
        if (prof.apiUrl && normalizeOrigin(prof.apiUrl) === envOrigin) {
          matchingProfile = prof
          break
        }
      }
    }

    // Explicit origin mismatch check:
    // If stored credentials specify an explicit apiUrl and its origin does not match envUrl,
    // reject accidental transmission of the stored bearer to the overridden arbitrary origin.
    if (stored.apiUrl && normalizeOrigin(stored.apiUrl) !== envOrigin && !matchingProfile) {
      return {
        apiKey: undefined,
        credentialKind: "none",
        apiUrl: envUrl,
        workspaceId: undefined,
        installId: stored.installId,
        source: "none",
        originMismatch: true,
      }
    }

    const effective = matchingProfile ?? stored
    return {
      apiKey: effective.apiKey ?? effective.oauthAccessToken,
      credentialKind: effective.apiKey ? "api-key" : effective.oauthAccessToken ? "oauth" : "none",
      apiUrl: envUrl,
      workspaceId: effective.workspaceId,
      installId: stored.installId,
      source: "file",
    }
  }

  return {
    apiKey: stored?.apiKey ?? stored?.oauthAccessToken,
    credentialKind: stored?.apiKey ? "api-key" : stored?.oauthAccessToken ? "oauth" : "none",
    apiUrl: envUrl ?? stored?.apiUrl ?? DEFAULT_API_URL,
    workspaceId: stored?.workspaceId,
    installId: stored?.installId,
    source: stored ? "file" : "none",
  }
}
