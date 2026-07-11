import { describe, it, expect, vi } from "vitest"
import { createHmac } from "crypto"

// Mock the env module to avoid loading real env vars
vi.mock("@lyrashield/config", () => ({
  env: {
    GITHUB_APP_ID: "test-app-id",
    GITHUB_APP_SLUG: "test-app",
    GITHUB_APP_PRIVATE_KEY: "test-private-key",
    GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
    NEXT_PUBLIC_APP_URL: "https://test.example.com",
  },
}))

// Mock logger
vi.mock("@lyrashield/logger", () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
  createLogger: vi.fn(() => ({
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  })),
}))

// Import after mocks are set up
import { verifyWebhookSignature, getInstallAppUrl } from "./github"

describe("verifyWebhookSignature", () => {
  const payload = JSON.stringify({
    action: "opened",
    installation: { id: 12345 },
    repository: { full_name: "octocat/hello-world" },
  })

  function makeValidSignature(): string {
    return "sha256=" + createHmac("sha256", "test-webhook-secret").update(payload).digest("hex")
  }

  it("accepts a valid signature", () => {
    const sig = makeValidSignature()
    expect(verifyWebhookSignature(payload, sig)).toBe(true)
  })

  it("rejects null signature", () => {
    expect(verifyWebhookSignature(payload, null)).toBe(false)
  })

  it("rejects empty signature", () => {
    expect(verifyWebhookSignature(payload, "")).toBe(false)
  })

  it("rejects signature without sha256= prefix", () => {
    const sig = makeValidSignature().slice(7)
    expect(verifyWebhookSignature(payload, sig)).toBe(false)
  })

  it("rejects signature with wrong secret", () => {
    const wrongSig = "sha256=" + createHmac("sha256", "wrong-secret").update(payload).digest("hex")
    expect(verifyWebhookSignature(payload, wrongSig)).toBe(false)
  })

  it("rejects signature for tampered payload", () => {
    const sig = makeValidSignature()
    const tampered = JSON.stringify({ action: "deleted", installation: { id: 999 } })
    expect(verifyWebhookSignature(tampered, sig)).toBe(false)
  })

  it("rejects signature of different length", () => {
    expect(verifyWebhookSignature(payload, "sha256=short")).toBe(false)
  })
})

describe("getInstallAppUrl", () => {
  it("returns a URL containing the app slug", () => {
    const url = getInstallAppUrl()
    expect(url).toBe("https://github.com/apps/test-app/installations/new")
  })

  it("does not include caller state", () => {
    const url = getInstallAppUrl()
    expect(url).not.toContain("state=")
  })
})
