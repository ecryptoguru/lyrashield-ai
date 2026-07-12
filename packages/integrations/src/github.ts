import { env } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"
import { createHmac, createSign, timingSafeEqual as cryptoTimingSafeEqual } from "crypto"
import { getRedis } from "./redis"

const GITHUB_API_BASE = "https://api.github.com"

const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
} as const

function getAppCredentials() {
  const appId = env.GITHUB_APP_ID
  const privateKey = env.GITHUB_APP_PRIVATE_KEY

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

/**
 * fetch() wrapper that retries transient GitHub failures: 5xx, 429, and 403s
 * that carry a Retry-After (secondary rate limit). A 403 WITHOUT Retry-After is
 * an auth/permission error and is NOT retried. Honors Retry-After, else backs
 * off exponentially (capped).
 */
async function githubFetch(url: string, init: RequestInit, retries = 3): Promise<Response> {
  let attempt = 0
  while (true) {
    const res = await fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(30_000),
    })
    if (res.ok || attempt >= retries) return res

    const retryAfter = res.headers.get("retry-after")
    const isSecondaryRateLimit = res.status === 403 && retryAfter !== null
    const retryable = res.status >= 500 || res.status === 429 || isSecondaryRateLimit
    if (!retryable) return res

    const delayMs = retryAfter ? Number(retryAfter) * 1000 : Math.min(1000 * 2 ** attempt, 8000)
    await new Promise((r) => setTimeout(r, delayMs))
    attempt++
  }
}

// ── Installation-token cache ──────────────────────────────────────────────────
// GitHub installation tokens are valid ~1h. Re-minting on every call (JWT sign
// + network round-trip) burns the tight installation-token rate limit once the
// worker/webhooks fetch per-event. Cache per installationId and re-mint only
// within TOKEN_SKEW_MS of expiry.
// The cache is stored in Redis when available so multiple instances/workers
// share tokens; otherwise it falls back to a local Map.
type CachedToken = { token: string; expiresAt: number }
const localTokenCache = new Map<number, CachedToken>()
const TOKEN_SKEW_MS = 5 * 60 * 1000
const TOKEN_TTL_MS = 55 * 60 * 1000
const TOKEN_CACHE_KEY = (installationId: number) => `github:token:${installationId}`

async function getCachedToken(installationId: number): Promise<CachedToken | null> {
  const redis = getRedis()
  if (redis) {
    try {
      const raw = await redis.get(TOKEN_CACHE_KEY(installationId))
      if (raw) {
        const parsed = JSON.parse(raw) as CachedToken
        if (parsed.expiresAt - Date.now() > TOKEN_SKEW_MS) {
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

  const local = localTokenCache.get(installationId)
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
  const redis = getRedis()
  if (redis) {
    try {
      const ttl = Math.max(0, expiresAt - Date.now() - TOKEN_SKEW_MS)
      await redis.set(
        TOKEN_CACHE_KEY(installationId),
        JSON.stringify({ token, expiresAt }),
        "PX",
        ttl
      )
      return
    } catch (err) {
      logger.warn("Failed to write GitHub token to Redis cache", {
        installationId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  localTokenCache.set(installationId, { token, expiresAt })
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
    logger.error("Failed to get installation token", { installationId, status: res.status, body })
    throw new Error(`Failed to get installation token: ${res.status}`)
  }

  const data = (await res.json()) as { token: string; expires_at?: string }
  const expiresAt = data.expires_at ? Date.parse(data.expires_at) : Date.now() + TOKEN_TTL_MS
  await setCachedToken(installationId, data.token, expiresAt)
  return data.token
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
  branch: string
): Promise<void> {
  const token = await getInstallationToken(installationId)
  const encodedContent = Buffer.from(content).toString("base64")
  const res = await githubFetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, ...GITHUB_HEADERS },
    body: JSON.stringify({
      message,
      content: encodedContent,
      branch,
    }),
  })
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
  baseBranch: string
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
    }),
  })
  if (!res.ok) {
    const respBody = await res.text()
    throw new Error(`Failed to create PR: ${res.status} ${respBody}`)
  }
  const data = (await res.json()) as { number: number; html_url: string }
  return { number: data.number, url: data.html_url }
}
