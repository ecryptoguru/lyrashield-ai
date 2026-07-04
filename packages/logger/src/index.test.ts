import { describe, it, expect } from "vitest"
import { __test } from "./index"

const { redact, safeStringify, isSensitiveKey } = __test

describe("logger — sensitive key detection", () => {
  it.each([
    "password",
    "Password",
    "GITHUB_WEBHOOK_SECRET",
    "accessToken",
    "refreshToken",
    "authorization",
    "apiKey",
    "privateKey",
    "verificationUrl",
    "vaultRef",
    "Cookie",
  ])("flags %s as sensitive", (k) => {
    expect(isSensitiveKey(k)).toBe(true)
  })

  it.each(["email", "userId", "installationId", "status", "repoFullName", "workspaceId"])(
    "does not flag %s",
    (k) => {
      expect(isSensitiveKey(k)).toBe(false)
    }
  )
})

describe("logger — redaction", () => {
  it("masks sensitive values, keeps the rest", () => {
    const out = redact(
      { email: "a@b.com", password: "hunter2", nested: { accessToken: "abc", ok: 1 } },
      new WeakSet(),
      0
    ) as Record<string, unknown>
    expect(out.email).toBe("a@b.com")
    expect(out.password).toBe("[REDACTED]")
    expect((out.nested as Record<string, unknown>).accessToken).toBe("[REDACTED]")
    expect((out.nested as Record<string, unknown>).ok).toBe(1)
  })

  it("redacts inside arrays", () => {
    const out = redact({ items: [{ secret: "x" }, { y: 2 }] }, new WeakSet(), 0) as Record<
      string,
      unknown
    >
    const items = out.items as Array<Record<string, unknown>>
    expect(items[0]!.secret).toBe("[REDACTED]")
    expect(items[1]!.y).toBe(2)
  })

  it("breaks circular references instead of throwing", () => {
    const a: Record<string, unknown> = { name: "a" }
    a.self = a
    expect(() => safeStringify({ level: "info", message: "m", timestamp: "t", ...a })).not.toThrow()
    const s = safeStringify({ level: "info", message: "m", timestamp: "t", ...a })
    expect(s).toContain("[Circular]")
  })

  it("captures Error name/message/stack", () => {
    const out = redact({ err: new Error("boom") }, new WeakSet(), 0) as Record<string, unknown>
    const err = out.err as Record<string, unknown>
    expect(err.name).toBe("Error")
    expect(err.message).toBe("boom")
  })
})
