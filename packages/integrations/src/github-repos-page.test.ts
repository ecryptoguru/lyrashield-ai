import { createCipheriv, createHash, hkdfSync, randomBytes } from "node:crypto"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), get: vi.fn() }))
vi.mock("@lyrashield/config", () => ({ env: process.env }))
vi.mock("@lyrashield/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }))
vi.mock("./redis", () => ({ getRedis: () => ({ get: mocks.get }) }))
vi.mock("./github-http", () => ({
  githubFetch: mocks.fetch,
  GITHUB_API_BASE: "https://api.github.test",
  GITHUB_HEADERS: { Accept: "application/json" },
}))
import { listInstallationReposPage } from "./github"

// A synthetic encrypted cache receipt exercises the unchanged API request without
// depending on developer credentials or accepting obsolete plaintext cache data.
function cachedToken() {
  const identity = `github:token:v2:${createHash("sha256").update("fixture-app").digest("hex")}:42:installation-default`
  const key = Buffer.from(
    hkdfSync("sha256", "fixture-auth-secret", "", "lyrashield-github-token-cache/v1", 32)
  )
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  cipher.setAAD(Buffer.from(identity))
  const data = JSON.stringify({ token: "synthetic", expiresAt: Date.now() + 3600000 })
  const encrypted = Buffer.concat([cipher.update(data, "utf8"), cipher.final()])
  return `v1:${Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url")}`
}

beforeEach(() => {
  vi.stubEnv("GITHUB_APP_ID", "fixture-app")
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "synthetic-unused-cache-fixture")
  vi.stubEnv("BETTER_AUTH_SECRET", "fixture-auth-secret")
})
afterEach(() => vi.unstubAllEnvs())
const repos = Array.from({ length: 50 }, (_, i) => ({ id: i, full_name: `example/repo-${i}` }))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.get.mockImplementation(async () => cachedToken())
})
it("makes one provider request for exactly 50 repositories and exposes the next page", async () => {
  mocks.fetch.mockResolvedValue(
    new Response(JSON.stringify({ repositories: repos, total_count: 120 }))
  )
  const result = await listInstallationReposPage(42, 2)
  expect(result).toEqual({ repositories: repos, nextPage: 3 })
  expect(mocks.fetch).toHaveBeenCalledOnce()
  expect(mocks.fetch).toHaveBeenCalledWith(
    "https://api.github.test/installation/repositories?per_page=50&page=2",
    expect.any(Object)
  )
})
it("does not offer another page after an exact full last page", async () => {
  mocks.fetch.mockResolvedValue(
    new Response(JSON.stringify({ repositories: repos, total_count: 100 }))
  )
  expect((await listInstallationReposPage(42, 2)).nextPage).toBeNull()
})
it("returns no more than 50 records even if an upstream page is oversized", async () => {
  mocks.fetch.mockResolvedValue(
    new Response(JSON.stringify({ repositories: [...repos, ...repos], total_count: 100 }))
  )
  expect((await listInstallationReposPage(42, 1)).repositories).toHaveLength(50)
})
