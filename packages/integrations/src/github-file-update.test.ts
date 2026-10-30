import { createCipheriv, createHash, hkdfSync, randomBytes } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock("@lyrashield/config", () => ({ env: process.env }))
vi.mock("@lyrashield/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }))
vi.mock("./redis", () => ({
  getRedis: () => ({
    get: async () => cachedToken(),
  }),
}))
vi.mock("./github-http", () => ({
  githubFetch: mocks.fetch,
  GITHUB_API_BASE: "https://api.github.com",
  GITHUB_HEADERS: {},
}))
import { createOrUpdateFile } from "./github"

// A synthetic encrypted cache receipt exercises the unchanged API request without
// depending on developer credentials or accepting obsolete plaintext cache data.
function cachedToken() {
  const identity = `github:token:v2:${createHash("sha256").update("fixture-app").digest("hex")}:1:installation-default`
  const key = Buffer.from(
    hkdfSync("sha256", "fixture-auth-secret", "", "lyrashield-github-token-cache/v1", 32)
  )
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  cipher.setAAD(Buffer.from(identity))
  const data = JSON.stringify({
    token: randomBytes(16).toString("hex"),
    expiresAt: Date.now() + 3600000,
  })
  const encrypted = Buffer.concat([cipher.update(data, "utf8"), cipher.final()])
  return `v1:${Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url")}`
}

beforeEach(() => {
  vi.stubEnv("GITHUB_APP_ID", "fixture-app")
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "synthetic-unused-cache-fixture")
  vi.stubEnv("BETTER_AUTH_SECRET", "fixture-auth-secret")
})
afterEach(() => vi.unstubAllEnvs())

describe("GitHub existing file updates", () => {
  afterEach(() => vi.clearAllMocks())
  it("sends the scanned blob SHA with the replacement content", async () => {
    mocks.fetch.mockResolvedValue({ ok: true })
    await createOrUpdateFile(
      1,
      "owner",
      "repo",
      "api/composer.lock",
      "new",
      "fix",
      "fix-branch",
      "489ce0f857e7634a0eb9f328265a3e91fad49f61"
    )
    const [, options] = mocks.fetch.mock.calls[0]!
    expect(JSON.parse(options.body)).toMatchObject({
      branch: "fix-branch",
      content: "bmV3",
      sha: "489ce0f857e7634a0eb9f328265a3e91fad49f61",
    })
  })
})
