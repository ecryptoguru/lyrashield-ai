import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@lyrashield/db", () => ({
  prisma: {
    target: {
      findFirst: vi.fn(),
    },
    scan: {
      count: vi.fn(),
    },
  },
  addScanEvent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@lyrashield/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// Keep tests hermetic: the real checkScanUrlSafe does live DNS resolution.
// Default to safe; individual tests override to exercise the unsafe path.
vi.mock("@lyrashield/security", () => ({
  checkScanUrlSafe: vi.fn().mockResolvedValue({ safe: true }),
}))

import { runPreflight } from "./preflight.job"
import { prisma } from "@lyrashield/db"
import { checkScanUrlSafe } from "@lyrashield/security"

const mockTarget = (overrides: Record<string, unknown> = {}) => ({
  id: "target-1",
  name: "Test Target",
  type: "WEB_APP",
  url: "https://example.com",
  repoFullName: null,
  deletedAt: null,
  ...overrides,
})

describe("runPreflight", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Restore the default after clearAllMocks wipes mock implementations.
    vi.mocked(checkScanUrlSafe).mockResolvedValue({ safe: true })
  })

  it("fails preflight when the target URL is not SSRF-safe", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue(mockTarget() as never)
    vi.mocked(checkScanUrlSafe).mockResolvedValue({
      safe: false,
      reason: "resolves_to_blocked_ip",
    })

    const result = await runPreflight("scan-1", "target-1")

    expect(result.passed).toBe(false)
    expect(result.errorCategory).toBe("PREFLIGHT")
    expect(result.errorMessage).toContain("resolves_to_blocked_ip")
    expect(result.checks.find((c) => c.name === "url_ssrf_safe")?.passed).toBe(false)
  })

  it("passes all checks for a valid WEB_APP target with no concurrent scans", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue(mockTarget() as never)
    vi.mocked(prisma.scan.count).mockResolvedValue(1 as never)

    const result = await runPreflight("scan-1", "target-1")

    expect(result.passed).toBe(true)
    expect(result.checks).toHaveLength(4)
    expect(result.checks[0]?.name).toBe("target_exists")
    expect(result.checks[0]?.passed).toBe(true)
    expect(result.checks[1]?.name).toBe("url_configured")
    expect(result.checks[1]?.passed).toBe(true)
    expect(result.checks[2]?.name).toBe("url_ssrf_safe")
    expect(result.checks[2]?.passed).toBe(true)
    expect(result.checks[3]?.name).toBe("no_concurrent_scan")
    expect(result.checks[3]?.passed).toBe(true)
  })

  it("passes for a REPO target with repoFullName", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue(
      mockTarget({ type: "REPO", url: null, repoFullName: "org/repo" }) as never
    )
    vi.mocked(prisma.scan.count).mockResolvedValue(1 as never)

    const result = await runPreflight("scan-2", "target-2")

    expect(result.passed).toBe(true)
    expect(result.checks.find((c) => c.name === "repo_configured")?.passed).toBe(true)
  })

  it("fails when target not found", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue(null as never)

    const result = await runPreflight("scan-3", "missing-target")

    expect(result.passed).toBe(false)
    expect(result.errorCategory).toBe("PREFLIGHT")
    expect(result.errorMessage).toBe("Target not found")
    expect(result.checks[0]?.name).toBe("target_exists")
    expect(result.checks[0]?.passed).toBe(false)
  })

  it("fails when REPO target has no repoFullName", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue(
      mockTarget({ type: "REPO", url: null, repoFullName: null }) as never
    )

    const result = await runPreflight("scan-4", "target-4")

    expect(result.passed).toBe(false)
    expect(result.errorMessage).toBe("Repository not configured")
  })

  it("fails when WEB_APP target has no url", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue(
      mockTarget({ type: "WEB_APP", url: null }) as never
    )

    const result = await runPreflight("scan-5", "target-5")

    expect(result.passed).toBe(false)
    expect(result.errorMessage).toBe("URL not configured")
  })

  it("fails when concurrent scan is running", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue(mockTarget() as never)
    vi.mocked(prisma.scan.count).mockResolvedValue(2 as never)

    const result = await runPreflight("scan-6", "target-6")

    expect(result.passed).toBe(false)
    expect(result.errorMessage).toBe("Concurrent scan already running")
    expect(result.checks.find((c) => c.name === "no_concurrent_scan")?.passed).toBe(false)
  })

  it("passes for IAC target with url", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue(
      mockTarget({ type: "IAC", url: "https://cloud.example.com/stack" }) as never
    )
    vi.mocked(prisma.scan.count).mockResolvedValue(1 as never)

    const result = await runPreflight("scan-7", "target-7")

    expect(result.passed).toBe(true)
    expect(result.checks.find((c) => c.name === "url_configured")?.passed).toBe(true)
  })
})
