import { env } from "@lyrashield/config"
import { z } from "zod"
import { githubFetch, GITHUB_API_BASE, GITHUB_HEADERS } from "./github-http"

// ── Install-callback ownership verification ──────────────────────────────────
// `installation_id` on the install callback is a global, enumerable identifier.
// On its own it proves nothing about the caller, so binding a workspace to it
// from the callback alone let a user claim someone else's installation (S2).
// The missing half is an assertion from GitHub about the *user*: with "Request
// user authorization (OAuth) during installation" enabled, GitHub appends a
// `code` to the callback. Exchanging it yields a user token whose
// GET /user/installations proves association, not installation-wide authority.
// Personal account ownership or active organization administration must also
// be verified before granting the installation to a workspace.
//
// The token is used for this one check and then discarded — never persisted.

/** Raised when the provider-side ownership handshake cannot be completed. */
export class GitHubOwnershipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GitHubOwnershipError"
  }
}

/** Exchange an install-callback `code` for a short-lived GitHub user token. */
export async function exchangeInstallUserCode(code: string): Promise<string> {
  const clientId = env.GITHUB_APP_CLIENT_ID
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new GitHubOwnershipError(
      "GitHub App OAuth credentials not configured (GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET)"
    )
  }

  const res = await githubFetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  })

  if (!res.ok) {
    throw new GitHubOwnershipError(`Install code exchange failed: ${res.status}`)
  }

  const data = (await res.json()) as { access_token?: string; error?: string }
  if (!data.access_token) {
    // GitHub returns 200 with an `error` body for bad/expired codes.
    throw new GitHubOwnershipError(
      `Install code exchange returned no token${data.error ? `: ${data.error}` : ""}`
    )
  }
  return data.access_token
}

async function getGitHubUserData(userToken: string, path: string): Promise<unknown> {
  const res = await githubFetch(`${GITHUB_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${userToken}`, ...GITHUB_HEADERS },
  })
  if (!res.ok) throw new GitHubOwnershipError(`GitHub user verification failed: ${res.status}`)
  return res.json()
}

const githubIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const installationAccountSchema = z.object({
  id: githubIdSchema,
  type: z.enum(["User", "Organization"]),
})
const organizationMembershipsSchema = z
  .array(
    z.object({
      state: z.string(),
      role: z.string(),
      organization: z.object({ id: githubIdSchema }),
    })
  )
  .max(100)

async function isInstallationAdministrator(
  userToken: string,
  account: unknown,
  read = (path: string) => getGitHubUserData(userToken, path)
): Promise<boolean> {
  const parsed = installationAccountSchema.safeParse(account)
  if (!parsed.success) return false
  if (parsed.data.type === "User") {
    const user = z.object({ id: githubIdSchema }).safeParse(await read("/user"))
    if (!user.success) throw new GitHubOwnershipError("Malformed GitHub user identity")
    return user.data.id === parsed.data.id
  }
  // This listing supports GitHub App user tokens without requesting additional
  // organization permissions. Repository access alone is never an admin grant.
  for (let page = 1; page <= 20; page++) {
    const memberships = organizationMembershipsSchema.safeParse(
      await read(`/user/memberships/orgs?state=active&per_page=100&page=${page}`)
    )
    if (!memberships.success) throw new GitHubOwnershipError("Malformed organization membership")
    if (
      memberships.data.some(
        (m) => m.organization.id === parsed.data.id && m.state === "active" && m.role === "admin"
      )
    )
      return true
    if (memberships.data.length < 100) return false
  }
  throw new GitHubOwnershipError("Organization membership verification exceeded page limit")
}

/**
 * True only when the user can access and administer the installation. Fails closed: any transport or parse problem
 * raises rather than returning false-negative-as-success.
 */
export async function userCanAdminInstallation(
  userToken: string,
  installationId: number
): Promise<boolean> {
  // Bounded rather than `while (true)`: this runs inside a request path, and an
  // unbounded pager driven by a remote response length is a hang waiting to
  // happen. 20 pages = 2,000 installations, far past any real account.
  const MAX_PAGES = 20

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await githubFetch(
      `${GITHUB_API_BASE}/user/installations?per_page=100&page=${page}`,
      {
        headers: { Authorization: `Bearer ${userToken}`, ...GITHUB_HEADERS },
      }
    )

    if (!res.ok) {
      throw new GitHubOwnershipError(`Failed to list user installations: ${res.status}`)
    }

    const data = (await res.json()) as { installations?: { id: number; account?: unknown }[] }
    const installations = data.installations ?? []
    const installation = installations.find((i) => i.id === installationId)
    if (installation) return isInstallationAdministrator(userToken, installation.account)
    if (installations.length < 100) return false
  }

  // Ran out of pages without a match: fail closed rather than guessing.
  throw new GitHubOwnershipError(
    `Exceeded ${MAX_PAGES} pages listing user installations without a match`
  )
}

/** Fresh request-local discovery. The token and response cache never escape this call. */
export async function getUserAdminInstallations(userToken: string, selectedId?: number) {
  const cache = new Map<string, Promise<unknown>>()
  const read = (path: string) => {
    let response = cache.get(path)
    if (!response) {
      response = getGitHubUserData(userToken, path)
      cache.set(path, response)
    }
    return response
  }
  const user = z.object({ id: githubIdSchema }).parse(await read("/user"))
  const installations: { id: number; login: string }[] = []
  const pageSchema = z.object({
    installations: z
      .array(
        z.object({
          id: githubIdSchema,
          account: installationAccountSchema.extend({ login: z.string().min(1).max(100) }),
        })
      )
      .max(100),
  })
  for (let page = 1; page <= 20; page++) {
    const data = pageSchema.parse(await read(`/user/installations?per_page=100&page=${page}`))
    for (const candidate of data.installations) {
      if (selectedId !== undefined && candidate.id !== selectedId) continue
      if (await isInstallationAdministrator(userToken, candidate.account, read)) {
        if (!installations.some((i) => i.id === candidate.id))
          installations.push({ id: candidate.id, login: candidate.account.login })
        if (installations.length > 20)
          throw new GitHubOwnershipError("Installation chooser limit exceeded")
      }
      if (selectedId !== undefined) return { userId: user.id, installations }
    }
    if (data.installations.length < 100) return { userId: user.id, installations }
  }
  throw new GitHubOwnershipError("Installation discovery page limit exceeded")
}
