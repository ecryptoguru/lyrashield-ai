import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock("@lyrashield/config", () => ({ env: {} }))
vi.mock("@lyrashield/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }))
vi.mock("./redis", () => ({
  getRedis: () => ({
    get: async () => JSON.stringify({ token: "tok-x", expiresAt: Date.now() + 3600000 }),
  }),
}))
vi.mock("./github-http", () => ({
  githubFetch: mocks.fetch,
  GITHUB_API_BASE: "https://api.github.com",
  GITHUB_HEADERS: {},
}))
import { createOrUpdateFile } from "./github"

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
