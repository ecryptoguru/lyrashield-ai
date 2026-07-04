import { env } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"
import { createHmac, createSign } from "crypto"

const GITHUB_API_BASE = "https://api.github.com"

function getAppCredentials() {
  const appId = env.GITHUB_APP_ID
  const privateKey = env.GITHUB_APP_PRIVATE_KEY

  if (!appId || !privateKey) {
    throw new Error("GitHub App credentials not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY)")
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

export async function getInstallationToken(installationId: number): Promise<string> {
  const jwt = createAppJWT()

  const res = await fetch(`${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  })

  if (!res.ok) {
    const body = await res.text()
    logger.error("Failed to get installation token", { installationId, status: res.status, body })
    throw new Error(`Failed to get installation token: ${res.status}`)
  }

  const data = (await res.json()) as { token: string }
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
    const res = await fetch(`${GITHUB_API_BASE}/installation/repositories?per_page=100&page=${page}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })

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

  const res = await fetch(`${GITHUB_API_BASE}/app/installations`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  })

  if (!res.ok) {
    throw new Error(`Failed to list installations: ${res.status}`)
  }

  return (await res.json()) as InstallationInfo[]
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

  if (expected.length !== provided.length) {
    return false
  }

  return timingSafeEqual(expected, provided)
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}

export function getInstallAppUrl(): string {
  const appId = env.GITHUB_APP_ID
  if (!appId) {
    throw new Error("GITHUB_APP_ID not configured")
  }
  const callbackUrl = `${env.NEXT_PUBLIC_APP_URL}/api/integrations/github/install/callback`
  return `https://github.com/apps/${appId}/installations/new?state=${encodeURIComponent(callbackUrl)}`
}
