import { beforeEach, afterEach, describe, it, expect, vi } from "vitest"
import { generateKeyPairSync, randomUUID } from "node:crypto"
const mocks = vi.hoisted(() => ({
  env: {
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: "",
    BETTER_AUTH_SECRET: "",
  },
  get: vi.fn(),
  set: vi.fn(),
}))
vi.mock("@lyrashield/config", () => ({ env: mocks.env }))
vi.mock("@lyrashield/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }))
vi.mock("./redis", () => ({ getRedis: () => ({ get: mocks.get, set: mocks.set }) }))
import * as github from "./github"
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
})
const token = randomUUID()
const expiry = () => new Date(Date.now() + 3600000).toISOString()
function provider(installation: unknown = { id: 123, suspended_at: null }, minted: object = {}) {
  const fetchMock = vi.fn(
    async (url: string, _init: RequestInit) =>
      new Response(
        JSON.stringify(
          url.endsWith("/installation")
            ? installation
            : {
                token,
                expires_at: expiry(),
                permissions: { contents: "read", metadata: "read" },
                repositories: [{ id: 42, full_name: "owner/private" }],
                ...minted,
              }
        )
      )
  )
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.env.GITHUB_APP_ID = "12345"
  mocks.env.BETTER_AUTH_SECRET = randomUUID()
  mocks.env.GITHUB_APP_PRIVATE_KEY = privateKey
  mocks.get.mockResolvedValue(null)
  mocks.set.mockResolvedValue("OK")
})
afterEach(() => vi.unstubAllGlobals())
describe("checkout credentials", () => {
  it("mints a fresh exact-repository read token without consulting either token cache", async () => {
    const fetchMock = provider()
    await github.getInstallationToken(123)
    mocks.get.mockClear()
    mocks.set.mockClear()
    fetchMock.mockClear()
    await expect(github.getRepositoryReadToken(123, "owner/private")).resolves.toBe(token)
    await expect(github.getRepositoryReadToken(123, "owner/private")).resolves.toBe(token)
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.set).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(4)
    const [url, init] = fetchMock.mock.calls[1]!
    expect(url).toContain("/app/installations/123/access_tokens")
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      repositories: ["private"],
      permissions: { contents: "read" },
    })
  })
  it.each([{ id: 456 }, { id: 123, suspended_at: "2026-10-30T00:00:00Z" }, null])(
    "rejects a wrong or suspended installation before mint: %j",
    async (installation) => {
      const fetchMock = provider(installation)
      await expect(github.getRepositoryReadToken(123, "owner/private")).rejects.toThrow()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )
  it.each([
    { repositories: [{ id: 42, full_name: "other/private" }] },
    {
      repositories: [
        { id: 42, full_name: "owner/private" },
        { id: 43, full_name: "owner/extra" },
      ],
    },
    { permissions: { contents: "write", metadata: "read" } },
    { permissions: { contents: "read", pull_requests: "write" } },
  ])("rejects returned credentials with excess or wrong scope: %j", async (minted) => {
    provider(undefined, minted)
    await expect(github.getRepositoryReadToken(123, "owner/private")).rejects.toThrow()
  })
  it("accepts omitted optional scope echoes because the request explicitly restricts scope", async () => {
    provider(undefined, { permissions: undefined, repositories: undefined })
    await expect(github.getRepositoryReadToken(123, "owner/private")).resolves.toBe(token)
  })
  it("keeps authorized write helper token requests separate from checkout permissions", async () => {
    const fetchMock = provider()
    await github.getInstallationToken(94321)
    expect(fetchMock.mock.calls[0]![1].body).toBeUndefined()
  })
  it("honors a later provider revocation instead of reusing the previous token", async () => {
    const fetchMock = provider()
    await github.getRepositoryReadToken(123, "owner/private")
    fetchMock.mockResolvedValue(new Response("{}", { status: 404 }))
    await expect(github.getRepositoryReadToken(123, "owner/private")).rejects.toThrow()
  })
  it.each(["owner/../repo", "https://github.com/owner/private", "owner/private.git/extra"])(
    "rejects invalid repository identity %s without provider calls",
    async (repo) => {
      const fetchMock = provider()
      await expect(github.getRepositoryReadToken(123, repo)).rejects.toThrow()
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )
})
describe("remaining installation token cache", () => {
  it("stores an authenticated encrypted value scoped to app, installation and default grant", async () => {
    provider()
    await github.getInstallationToken(73432)
    const [key, value] = mocks.set.mock.calls[0]!
    expect(key).toContain("github:token:v2:")
    expect(key).toContain(":73432:installation-default")
    expect(value).not.toContain(token)
    expect(value).toMatch(/^v1:/)
    mocks.get.mockResolvedValue(value)
    vi.mocked(fetch).mockClear()
    await expect(github.getInstallationToken(73432)).resolves.toBe(token)
    expect(fetch).not.toHaveBeenCalled()
  })
  it("rejects cached ciphertext from another app or with a modified authentication tag", async () => {
    const fetchMock = provider()
    await github.getInstallationToken(73436)
    const [key, value] = mocks.set.mock.calls[0]!
    mocks.get.mockResolvedValue(value)
    mocks.env.GITHUB_APP_ID = "67890"
    await github.getInstallationToken(73436)
    expect(mocks.get.mock.calls[1]![0]).not.toBe(key)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const encrypted = Buffer.from(value.slice(3), "base64url")
    encrypted[12] = encrypted[12]! ^ 1
    mocks.get.mockResolvedValue(`v1:${encrypted.toString("base64url")}`)
    await github.getInstallationToken(73436)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
  it("rejects plaintext and ciphertext copied to a different installation cache key", async () => {
    const fetchMock = provider()
    await github.getInstallationToken(73433)
    const value = mocks.set.mock.calls[0]![1]
    mocks.get.mockResolvedValue(value)
    await github.getInstallationToken(73434)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    mocks.get.mockResolvedValue(JSON.stringify({ token, expiresAt: Date.now() + 3600000 }))
    await github.getInstallationToken(73435)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
