import { afterEach, describe, expect, it, vi } from "vitest"
import { createVerify, generateKeyPairSync } from "node:crypto"

const credentials = vi.hoisted(() => ({ GITHUB_APP_ID: "12345", GITHUB_APP_PRIVATE_KEY: "" }))
vi.mock("@lyrashield/config", () => ({ env: credentials }))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))
vi.mock("./redis", () => ({ getRedis: () => null }))
import { createAppJWT, getInstallationToken } from "./github"

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
})
function verifyJWT(jwt: string) {
  const [header, payload, signature] = jwt.split(".")
  const verifier = createVerify("RSA-SHA256").update(`${header}.${payload}`)
  expect(verifier.verify(publicKey, signature!, "base64url")).toBe(true)
  expect(JSON.parse(Buffer.from(payload!, "base64url").toString()).iss).toBe("12345")
}
afterEach(() => vi.unstubAllGlobals())
describe("GitHub worker credentials", () => {
  it.each(["multiline", "escaped"])("signs real JWTs with %s PEM", (format) => {
    credentials.GITHUB_APP_PRIVATE_KEY =
      format === "escaped" ? privateKey.replace(/\n/g, "\\n") : privateKey
    verifyJWT(createAppJWT())
  })
  it("mints a cold-cache installation token with the worker env-file PEM", async () => {
    credentials.GITHUB_APP_PRIVATE_KEY = privateKey.replace(/\n/g, "\\n")
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      verifyJWT((init.headers as Record<string, string>).Authorization!.slice(7))
      return new Response(
        JSON.stringify({
          token: "ghs_fixture",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        })
      )
    })
    vi.stubGlobal("fetch", fetchMock)
    await expect(getInstallationToken(987654321)).resolves.toBe("ghs_fixture")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toContain("/app/installations/987654321/access_tokens")
  })
  it.each(["", "invalid-private-key"])("rejects missing or invalid signing material", (value) => {
    credentials.GITHUB_APP_PRIVATE_KEY = value
    expect(() => createAppJWT()).toThrow()
  })
})
