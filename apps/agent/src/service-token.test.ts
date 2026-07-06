import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { signServiceToken, verifyServiceToken } from "./service-token"

const TEST_SECRET = "test-secret-at-least-32-characters-long-xxxxx"

describe("Service Token", () => {
  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = TEST_SECRET
  })

  afterEach(() => {
    delete process.env.BETTER_AUTH_SECRET
  })

  it("signs and verifies a valid token", () => {
    const token = signServiceToken({
      userId: "user-1",
      workspaceId: "ws-1",
      role: "ADMIN",
    })

    expect(token.startsWith("lst.")).toBe(true)

    const payload = verifyServiceToken(token)
    expect(payload).not.toBeNull()
    expect(payload!.userId).toBe("user-1")
    expect(payload!.workspaceId).toBe("ws-1")
    expect(payload!.role).toBe("ADMIN")
    expect(payload!.issuedAt).toBeGreaterThan(0)
    expect(payload!.expiresAt).toBeGreaterThan(payload!.issuedAt)
  })

  it("rejects token with wrong prefix", () => {
    const result = verifyServiceToken("wrong.token.here")
    expect(result).toBeNull()
  })

  it("rejects tampered token", () => {
    const token = signServiceToken({
      userId: "user-1",
      workspaceId: "ws-1",
      role: "ADMIN",
    })

    const parts = token.split(".")
    const tampered = `${parts[0]}.${parts[1]}.tampered_signature`
    const result = verifyServiceToken(tampered)
    expect(result).toBeNull()
  })

  it("rejects expired token", () => {
    const token = signServiceToken({
      userId: "user-1",
      workspaceId: "ws-1",
      role: "ADMIN",
    })

    const payload = verifyServiceToken(token)
    expect(payload).not.toBeNull()

    const parts = token.split(".")
    const payloadData = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8")
    )
    payloadData.expiresAt = Math.floor(Date.now() / 1000) - 100
    const tamperedPayload = Buffer.from(JSON.stringify(payloadData)).toString("base64url")
    const tamperedToken = `lst.${tamperedPayload}.${parts[2]}`

    const result = verifyServiceToken(tamperedToken)
    expect(result).toBeNull()
  })

  it("rejects token with malformed payload", () => {
    const token = `lst.${Buffer.from("not-json").toString("base64url")}.${Buffer.from("sig").toString("base64url")}`
    const result = verifyServiceToken(token)
    expect(result).toBeNull()
  })

  it("throws if BETTER_AUTH_SECRET is missing", () => {
    delete process.env.BETTER_AUTH_SECRET
    expect(() =>
      signServiceToken({ userId: "u", workspaceId: "w", role: "ADMIN" })
    ).toThrow()
  })

  it("throws if BETTER_AUTH_SECRET is too short", () => {
    process.env.BETTER_AUTH_SECRET = "short"
    expect(() =>
      signServiceToken({ userId: "u", workspaceId: "w", role: "ADMIN" })
    ).toThrow()
  })

  it("rejects token with valid signature but missing payload fields", () => {
    const secret = TEST_SECRET
    const malformedPayload = { userId: "u" } // missing workspaceId, role, issuedAt, expiresAt
    const payloadEncoded = Buffer.from(JSON.stringify(malformedPayload)).toString("base64url")
    const signature = require("node:crypto").createHmac("sha256", secret).update(payloadEncoded).digest()
    const signatureEncoded = signature.toString("base64url")
    const token = `lst.${payloadEncoded}.${signatureEncoded}`

    const result = verifyServiceToken(token)
    expect(result).toBeNull()
  })
})
