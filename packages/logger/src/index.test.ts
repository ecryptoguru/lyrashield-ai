import { describe, it, expect, vi } from "vitest"
import { AsyncLocalStorage } from "node:async_hooks"
import { __test, activeRequestId, logger, setRequestId, setRequestIdResolver } from "./index"

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
    // VERIFY-I-002 — marker gap coverage
    "api_key",
    "x-api-key",
    "private_key",
    "jwt",
    "bearer",
    "passphrase",
    "dsn",
    "sessionId",
    "signingKey",
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

  // VERIFY-I-003: secret VALUES embedded in Error messages / string meta
  // bypass key-name redaction — they must be scrubbed by shape.
  it.each([
    ["lsk_4f8ab12cd9ef0011", "a workspace API key"],
    ["Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc123.def456", "a bearer token"],
    [
      "postgresql://user:s3cret-pw@db.example.com:5432/prod",
      "a credentialed DSN",
    ],
    // Built at runtime — a literal sk_live_* trips push protection even
    // with an obviously fake tail.
    [`sk${"_"}live_${"0".repeat(24)}`, "a provider live key"],
  ])("scrubs %s from Error messages and plain strings", (secret, _label) => {
    const out = redact(
      {
        err: new Error(`call failed with ${secret}`),
        detail: `connect using ${secret} now`,
        note: "nothing sensitive here",
      },
      new WeakSet(),
      0
    ) as Record<string, unknown>
    const serialized = JSON.stringify(out)
    expect(serialized).not.toContain(secret)
    expect(serialized).toContain("[REDACTED]")
    expect(out.note).toBe("nothing sensitive here")
    expect((out.err as Record<string, unknown>).message).toContain("[REDACTED]")
  })
})

describe("logger — request correlation", () => {
  it("stamps the scoped id for interleaved requests, never a neighbor's", async () => {
    // F5 regression: request A pauses mid-flight while request B resolves —
    // A's resumed logs must still carry request-A, not the module global B set.
    const storage = new AsyncLocalStorage<{ requestId: string }>()
    setRequestIdResolver(() => storage.getStore()?.requestId)
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined)

    try {
      const seen: string[] = []
      const run = (requestId: string, marker: string, before: () => Promise<void>) =>
        storage.run({ requestId }, async () => {
          await before()
          logger.info(marker)
          seen.push(JSON.parse(stdout.mock.lastCall![0] as string).requestId)
        })

      const aStarted = Promise.withResolvers<void>()
      const bDone = Promise.withResolvers<void>()
      const a = run("request-A", "line from A", async () => {
        aStarted.resolve()
        await bDone.promise
      })
      const b = run("request-B", "line from B", async () => {
        await aStarted.promise
      })
      await b
      bDone.resolve()
      await a

      expect(seen).toEqual(["request-B", "request-A"])
      expect(activeRequestId()).toBeUndefined()
    } finally {
      stdout.mockRestore()
      setRequestIdResolver(undefined)
      setRequestId(undefined)
    }
  })

  it("keeps the legacy module variable when no resolver scope is active", () => {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined)
    try {
      setRequestId("worker-job-1")
      logger.info("job line")
      expect(JSON.parse(stdout.mock.lastCall![0] as string).requestId).toBe("worker-job-1")
    } finally {
      stdout.mockRestore()
      setRequestId(undefined)
    }
  })
})

describe("logger — destination", () => {
  it("keeps protocol stdout clean when stderr is requested", () => {
    const previous = process.env.LYRASHIELD_LOG_DESTINATION
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined)
    process.env.LYRASHIELD_LOG_DESTINATION = "stderr"

    try {
      logger.info("stdio ready")

      expect(stdout).not.toHaveBeenCalled()
      expect(stderr).toHaveBeenCalledOnce()
    } finally {
      stdout.mockRestore()
      stderr.mockRestore()
      if (previous === undefined) delete process.env.LYRASHIELD_LOG_DESTINATION
      else process.env.LYRASHIELD_LOG_DESTINATION = previous
    }
  })
})
