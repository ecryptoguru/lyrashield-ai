import { env } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"
import {
  createHmac,
  createSign,
  timingSafeEqual as cryptoTimingSafeEqual,
  createHash,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "crypto"
import { z } from "zod"
import { getRedis } from "./redis"

import { githubFetch, GITHUB_API_BASE, GITHUB_HEADERS } from "./github-http"
export { githubFetch, GITHUB_API_BASE, GITHUB_HEADERS } from "./github-http"

function getAppCredentials() {
  const appId = env.GITHUB_APP_ID
  // Docker env files store the worker PEM on one line. App secrets may remain multiline.
  const privateKey = env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n")

  if (!appId || !privateKey) {
    throw new Error(
      "GitHub App credentials not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY)"
    )
  }

  return { appId, privateKey }
}

export function createAppJWT(): string {
  const { appId, privateKey } = getAppCredentials()

  const now = Math.floor(Date.now() / 1000)
  const payload = {
    iat: now - 60,
    exp: now + 10 * 60,
    iss: appId,
  }

  const header = { alg: "RS256", typ: "JWT" }
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url")
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const data = `${encodedHeader}.${encodedPayload}`

  const sign = createSign("RSA-SHA256")
  sign.update(data)
  sign.end()
  const signature = sign.sign(privateKey, "base64url")

  return `${data}.${signature}`
}

// ── Installation-token cache ──────────────────────────────────────────────────
// GitHub installation tokens are valid ~1h. Re-minting on every call (JWT sign
// + network round-trip) burns the tight installation-token rate limit once the
// worker/webhooks fetch per-event. Cache per installationId and re-mint only
// within TOKEN_SKEW_MS of expiry.
// The cache is stored in Redis when available so multiple instances/workers
// share tokens; otherwise it falls back to a local Map.
type CachedToken = { token: string; expiresAt: number }
const localTokenCache = new Map<string, CachedToken>()
const TOKEN_SKEW_MS = 5 * 60 * 1000
const TOKEN_TTL_MS = 55 * 60 * 1000
const TOKEN_CACHE_KEY = (installationId: number) => {
  const { appId } = getAppCredentials()
  const appIdentity = createHash("sha256").update(appId).digest("hex")
  return `github:token:v2:${appIdentity}:${installationId}:installation-default`
}

function cacheEncryptionKey(): Buffer {
  return Buffer.from(
    hkdfSync("sha256", env.BETTER_AUTH_SECRET, "", "lyrashield-github-token-cache/v1", 32)
  )
}

function encryptCachedToken(value: CachedToken, identity: string): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", cacheEncryptionKey(), nonce)
  cipher.setAAD(Buffer.from(identity))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()])
  return `v1:${Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url")}`
}

function decryptCachedToken(raw: string, identity: string): CachedToken | null {
  // Old plaintext entries expire naturally; never read them into credentials.
  if (!raw.startsWith("v1:")) return null
  const encrypted = Buffer.from(raw.slice(3), "base64url")
  if (encrypted.length <= 28) return null
  const decipher = createDecipheriv("aes-256-gcm", cacheEncryptionKey(), encrypted.subarray(0, 12))
  decipher.setAAD(Buffer.from(identity))
  decipher.setAuthTag(encrypted.subarray(12, 28))
  return parseCachedToken(
    Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString("utf8")
  )
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/\s/.test(value)
}

export function parseCachedToken(raw: string): CachedToken | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  if (!("token" in value) || !("expiresAt" in value)) return null
  if (!validToken(value.token)) return null
  if (typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt)) return null
  if (value.expiresAt <= 0) return null
  return { token: value.token, expiresAt: value.expiresAt }
}

export function parseInstallationTokenResponse(value: unknown): CachedToken {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("token" in value)) {
    throw new Error("Invalid GitHub installation token response")
  }
  if (!validToken(value.token)) throw new Error("Invalid GitHub installation token response")
  const rawExpiry = "expires_at" in value ? value.expires_at : undefined
  if (rawExpiry !== undefined && typeof rawExpiry !== "string") {
    throw new Error("Invalid GitHub installation token response")
  }
  const expiresAt = rawExpiry ? Date.parse(rawExpiry) : Date.now() + TOKEN_TTL_MS
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("Invalid GitHub installation token response")
  }
  return { token: value.token, expiresAt }
}

async function getCachedToken(installationId: number): Promise<CachedToken | null> {
  const identity = TOKEN_CACHE_KEY(installationId)
  const redis = getRedis()
  if (redis) {
    try {
      const raw = await redis.get(identity)
      if (raw) {
        const parsed = decryptCachedToken(raw, identity)
        if (parsed && parsed.expiresAt - Date.now() > TOKEN_SKEW_MS) {
          return parsed
        }
      }
    } catch (err) {
      logger.warn("Failed to read GitHub token from Redis cache", {
        installationId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const local = localTokenCache.get(identity)
  if (local && local.expiresAt - Date.now() > TOKEN_SKEW_MS) {
    return local
  }
  return null
}

async function setCachedToken(
  installationId: number,
  token: string,
  expiresAt: number
): Promise<void> {
  const identity = TOKEN_CACHE_KEY(installationId)
  const redis = getRedis()
  if (redis) {
    try {
      const ttl = Math.max(0, expiresAt - Date.now() - TOKEN_SKEW_MS)
      await redis.set(identity, encryptCachedToken({ token, expiresAt }, identity), "PX", ttl)
      return
    } catch (err) {
      logger.warn("Failed to write GitHub token to Redis cache", {
        installationId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  localTokenCache.set(identity, { token, expiresAt })
}

export async function getInstallationToken(installationId: number): Promise<string> {
  const cached = await getCachedToken(installationId)
  if (cached) {
    return cached.token
  }

  const jwt = createAppJWT()

  const res = await githubFetch(
    `${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, ...GITHUB_HEADERS },
    }
  )

  if (!res.ok) {
    const body = await res.text()
    logger.error("Failed to get installation token", {
      installationId,
      status: res.status,
      body: body.slice(0, 200),
    })
    throw new Error(`Failed to get installation token: ${res.status}`)
  }

  const data = parseInstallationTokenResponse(await res.json())
  await setCachedToken(installationId, data.token, data.expiresAt)
  return data.token
}

const checkoutRepositorySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/)
  .refine((value) => !value.split("/").some((part) => part === "." || part === ".."))

/** Low-level mint; callers must authorize the workspace's active integration first.
 * Never shares a token with installation-wide API/write helpers or a cache.
 */
export async function getRepositoryReadToken(
  installationId: number,
  repoFullName: string
): Promise<string> {
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(installationId)
  checkoutRepositorySchema.parse(repoFullName)
  const jwt = createAppJWT()
  const headers = { Authorization: `Bearer ${jwt}`, ...GITHUB_HEADERS }
  const installationResponse = await githubFetch(
    `${GITHUB_API_BASE}/repos/${repoFullName}/installation`,
    { headers, redirect: "error" }
  )
  if (!installationResponse.ok)
    throw new Error(`Repository installation is unavailable: ${installationResponse.status}`)
  const installation = z
    .object({ id: z.number().int().positive(), suspended_at: z.null().optional() })
    .parse(await installationResponse.json())
  if (installation.id !== installationId)
    throw new Error("Repository installation identity mismatch")
  const response = await githubFetch(
    `${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      redirect: "error",
      body: JSON.stringify({
        repositories: [repoFullName.split("/")[1]],
        permissions: { contents: "read" },
      }),
    },
    0
  )
  if (!response.ok) throw new Error(`Failed to get repository read token: ${response.status}`)
  const data = z
    .object({
      token: z.string(),
      expires_at: z.string(),
      permissions: z.record(z.string(), z.string()).optional(),
      repositories: z.array(z.object({ full_name: z.string() })).optional(),
      repository_selection: z.enum(["all", "selected"]).optional(),
    })
    .parse(await response.json())
  // Explicit request scope is authoritative when optional metadata is omitted.
  // If GitHub echoes scope, reject any contradiction rather than broadening it.
  if (
    data.permissions &&
    (data.permissions.contents !== "read" ||
      Object.entries(data.permissions).some(
        ([name, access]) => !["contents", "metadata"].includes(name) || access !== "read"
      ))
  )
    throw new Error("Repository token permissions mismatch")
  if (
    data.repository_selection === "all" ||
    (data.repositories &&
      (data.repositories.length !== 1 ||
        data.repositories[0]!.full_name.toLowerCase() !== repoFullName.toLowerCase()))
  )
    throw new Error("Repository token identity mismatch")
  return parseInstallationTokenResponse(data).token
}

export interface GitHubRepo {
  id: number
  full_name: string
  name: string
  owner: { login: string }
  default_branch: string
  private: boolean
  html_url: string
}

/** One bounded provider request for interactive repository pickers. */
export async function listInstallationReposPage(
  installationId: number,
  page: number
): Promise<{ repositories: GitHubRepo[]; nextPage: number | null }> {
  if (!Number.isSafeInteger(page) || page < 1 || page > 10_000)
    throw new Error("Invalid repository page")
  const token = await getInstallationToken(installationId)
  const res = await githubFetch(
    `${GITHUB_API_BASE}/installation/repositories?per_page=50&page=${page}`,
    { headers: { Authorization: `Bearer ${token}`, ...GITHUB_HEADERS } }
  )
  if (!res.ok) throw new Error(`Failed to list repos: ${res.status}`)
  const data = (await res.json()) as { repositories: GitHubRepo[]; total_count?: number }
  return {
    repositories: data.repositories.slice(0, 50),
    nextPage:
      data.repositories.length === 50 &&
      (data.total_count === undefined || page * 50 < data.total_count) &&
      page < 10_000
        ? page + 1
        : null,
  }
}

export async function listInstallationRepos(installationId: number): Promise<GitHubRepo[]> {
  const token = await getInstallationToken(installationId)
  const repos: GitHubRepo[] = []
  let page = 1
  let hasMore = true

  while (hasMore) {
    const res = await githubFetch(
      `${GITHUB_API_BASE}/installation/repositories?per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${token}`, ...GITHUB_HEADERS } }
    )

    if (!res.ok) {
      logger.error("Failed to list installation repos", { installationId, status: res.status })
      throw new Error(`Failed to list repos: ${res.status}`)
    }

    const data = (await res.json()) as { repositories: GitHubRepo[] }
    repos.push(...data.repositories)
    hasMore = data.repositories.length === 100
    page++
  }

  return repos
}

export interface InstallationInfo {
  id: number
  account: {
    login: string
    id: number
    type: string
  }
  /**
   * Granted app permissions as the provider reports them, e.g.
   * `{ contents: "read", metadata: "read" }`. Absent only if the provider
   * omits the field — consumers must treat that as "no permissions", never
   * as a full grant.
   */
  permissions?: Record<string, string>
  /**
   * Whether the installation reaches "all" current and future repositories
   * or a "selected" list (enumerable via GET /installation/repositories).
   * Consumers should treat any other or missing value as "selected" — the
   * narrower reading fails closed.
   */
  repository_selection?: "all" | "selected"
}

export async function getAppInstallations(): Promise<InstallationInfo[]> {
  const jwt = createAppJWT()
  const installations: InstallationInfo[] = []
  let page = 1
  let hasMore = true

  while (hasMore) {
    const res = await githubFetch(
      `${GITHUB_API_BASE}/app/installations?per_page=100&page=${page}`,
      {
        headers: { Authorization: `Bearer ${jwt}`, ...GITHUB_HEADERS },
      }
    )

    if (!res.ok) {
      throw new Error(`Failed to list installations: ${res.status}`)
    }

    const data = (await res.json()) as InstallationInfo[]
    installations.push(...data)
    hasMore = data.length === 100
    page++
  }

  return installations
}

export {
  exchangeInstallUserCode,
  userCanAdminInstallation,
  getUserAdminInstallations,
  GitHubOwnershipError,
} from "./github-ownership"

export function verifyWebhookSignature(payload: string, signature: string | null): boolean {
  const secret = env.GITHUB_WEBHOOK_SECRET
  if (!secret) {
    logger.error("GITHUB_WEBHOOK_SECRET not configured")
    return false
  }

  if (!signature || !signature.startsWith("sha256=")) {
    return false
  }

  const expected = createHmac("sha256", secret).update(payload).digest("hex")
  const provided = signature.slice(7)

  // crypto.timingSafeEqual throws on unequal-length buffers, so length-check first.
  if (expected.length !== provided.length) {
    return false
  }

  return cryptoTimingSafeEqual(Buffer.from(expected), Buffer.from(provided))
}

export function getInstallAppUrl(): string {
  const slug = env.GITHUB_APP_SLUG
  if (!slug) {
    throw new Error("GITHUB_APP_SLUG not configured")
  }
  // GitHub's public installation URL is keyed by the app SLUG, not the numeric
  // app id (`https://github.com/apps/{slug}/installations/new`) — using the id
  // produces a 404. The `state` parameter is set by the caller (POST
  // /api/integrations/github/install sets it to the workspaceId, which the GET
  // callback then reads back), so we intentionally do not embed one here.
  return `https://github.com/apps/${slug}/installations/new`
}

export async function getDefaultBranch(
  installationId: number,
  owner: string,
  repo: string
): Promise<string> {
  const token = await getInstallationToken(installationId)
  const res = await githubFetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}`, {
    headers: { Authorization: `Bearer ${token}`, ...GITHUB_HEADERS },
  })
  if (!res.ok) {
    throw new Error(`Failed to get repo info: ${res.status}`)
  }
  const data = (await res.json()) as { default_branch: string }
  return data.default_branch
}

export async function getBranchRefSha(
  installationId: number,
  owner: string,
  repo: string,
  branch: string
): Promise<string> {
  const token = await getInstallationToken(installationId)
  const res = await githubFetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/refs/heads/${branch}`,
    { headers: { Authorization: `Bearer ${token}`, ...GITHUB_HEADERS } }
  )
  if (!res.ok) {
    throw new Error(`Failed to get branch ref: ${res.status}`)
  }
  const data = (await res.json()) as { object: { sha: string } }
  return data.object.sha
}

/**
 * Resolve the effective merge base of base...head through the authorized
 * GitHub App installation. Returns the merge-base commit SHA, or null when
 * the histories are unrelated. Callers must persist the resolved value — the
 * comparison is only authoritative as an immutable object ID.
 */
export async function getMergeBaseSha(
  installationId: number,
  owner: string,
  repo: string,
  base: string,
  head: string
): Promise<string | null> {
  const token = await getInstallationToken(installationId)
  // Callers pass resolved SHAs or git-validated refs only — no encoding, same
  // contract as getBranchRefSha above.
  const res = await githubFetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/compare/${base}...${head}`,
    { headers: { Authorization: `Bearer ${token}`, ...GITHUB_HEADERS } }
  )
  if (!res.ok) {
    throw new Error(`Failed to compare refs: ${res.status}`)
  }
  const data = (await res.json()) as { merge_base_commit?: { sha?: string } | null }
  return data.merge_base_commit?.sha ?? null
}

/**
 * Fetch a file's text content at a ref (branch/SHA). Used by the WP3 fix-PR
 * pipeline to read the current content a validated patch applies against.
 * Returns null when the path does not exist at that ref (404).
 */
export async function getFileContent(
  installationId: number,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<string | null> {
  const token = await getInstallationToken(installationId)
  const res = await githubFetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
    { headers: { Authorization: `Bearer ${token}`, ...GITHUB_HEADERS } }
  )
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read file ${path}: ${res.status}`)
  }
  const data = (await res.json()) as { content?: string; encoding?: string }
  if (typeof data.content !== "string") return null
  // GitHub returns base64 with embedded newlines.
  return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8")
}

export async function createBranch(
  installationId: number,
  owner: string,
  repo: string,
  branchName: string,
  fromSha: string
): Promise<void> {
  const token = await getInstallationToken(installationId)
  const res = await githubFetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, ...GITHUB_HEADERS },
    body: JSON.stringify({
      ref: `refs/heads/${branchName}`,
      sha: fromSha,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Failed to create branch: ${res.status} ${body}`)
  }
}

export async function createOrUpdateFile(
  installationId: number,
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  branch: string,
  sha: string
): Promise<void> {
  const token = await getInstallationToken(installationId)
  const encodedContent = Buffer.from(content).toString("base64")
  // VERIFY-D-001: encode the path exactly as getFileContent does — WHATWG URL
  // normalization would otherwise collapse "x/../" on the write and the two
  // sides could disagree about which path was read vs written.
  const res = await githubFetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, ...GITHUB_HEADERS },
      body: JSON.stringify({
        message,
        content: encodedContent,
        branch,
        sha,
      }),
    }
  )
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Failed to update file: ${res.status} ${body}`)
  }
}

export async function createPullRequest(
  installationId: number,
  owner: string,
  repo: string,
  title: string,
  body: string,
  headBranch: string,
  baseBranch: string,
  options?: { draft?: boolean }
): Promise<{ number: number; url: string }> {
  const token = await getInstallationToken(installationId)
  const res = await githubFetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, ...GITHUB_HEADERS },
    body: JSON.stringify({
      title,
      body,
      head: headBranch,
      base: baseBranch,
      ...(options?.draft ? { draft: true } : {}),
    }),
  })
  if (!res.ok) {
    const respBody = await res.text()
    throw new Error(`Failed to create PR: ${res.status} ${respBody}`)
  }
  const data = (await res.json()) as { number: number; html_url: string }
  return { number: data.number, url: data.html_url }
}
