import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { requiredScannersForTarget } from "@lyrashield/gate"
import { RESULT_MANIFEST_VERSION } from "@lyrashield/types"

const state = vi.hoisted((): { tx: Record<string, unknown> } => ({ tx: {} }))
vi.mock("./rls", () => ({
  withWorkspaceRLS: async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn(state.tx),
}))
import { evaluateGateForTarget } from "./gate-evaluation-service"
import { getCurrentGateVerdict } from "./gate-service"

function setup() {
  const endedAt = new Date(Date.now() - 60_000)
  const coverage = requiredScannersForTarget("REPO", "STANDARD").map((scanner) => ({
    scanner,
    controlId: scanner,
    status: "COMPLETED",
    reason: null,
    subject: null,
    metadata: null,
  }))
  const manifest = {
    target: { id: "target", type: "REPO" },
    sourceExecution: { sourceRevision: "a".repeat(40) },
    terminalOutcome: { status: "COMPLETED" },
    coverage,
  }
  const checksumInput = JSON.stringify(manifest)
  const resultManifest = {
    version: RESULT_MANIFEST_VERSION,
    checksum: createHash("sha256").update(checksumInput).digest("hex"),
    checksumInput: checksumInput as string | null,
    manifest,
  }
  const rows = coverage.map((row) => ({ ...row }))
  const bounds = { manifestTooLarge: false }
  const scan = {
    id: "scan",
    endedAt,
    status: "COMPLETED",
    mode: "STANDARD",
    policyId: "policy",
    resultManifest,
  }
  let stored: Record<string, unknown> | null = null
  state.tx = {
    target: { findFirst: vi.fn().mockResolvedValue({ id: "target", type: "REPO" }) },
    scan: {
      findFirst: vi.fn(async ({ where }) => (where.status === "COMPLETED" ? scan : null)),
    },
    policy: { findFirst: vi.fn().mockResolvedValue({ id: "policy", workspaceId: "ws" }) },
    scanCoverageReceipt: { findMany: vi.fn(async () => rows) },
    finding: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    findingVerification: { findFirst: vi.fn().mockResolvedValue(null) },
    gateVerdict: {
      create: vi.fn(async ({ data }) => {
        stored = { ...data, id: "verdict", evaluatedAt: new Date() }
        return { id: "verdict" }
      }),
      findFirst: vi.fn(async () => stored),
    },
    $queryRaw: vi.fn(async (sql: TemplateStringsArray) => {
      if (sql.join("?").includes("WITH selected AS MATERIALIZED"))
        return stored ? [{ ...stored, evidenceTooLarge: false }] : []
      if (sql.join("?").includes('AS "candidateManifest"'))
        return [
          {
            candidateManifest:
              bounds.manifestTooLarge || resultManifest.checksumInput === null
                ? null
                : resultManifest,
          },
        ]
      if (sql.join("?").includes('AS "requestedTargetId"'))
        return [
          {
            requestedTargetId: "target",
            targetId: "target",
            targetWorkspaceId: "ws",
            targetType: "REPO",
            scanId: "scan",
            scanWorkspaceId: "ws",
            scanTargetId: "target",
            status: "COMPLETED",
            mode: "STANDARD",
            endedAt,
            policyId: "policy",
            resultManifest: resultManifest.checksumInput === null ? null : resultManifest,
            coverageReceipts: rows,
            overflow: false,
          },
        ]
      return []
    }),
  }
  return { resultManifest, rows, bounds }
}

describe("gate evaluation qualifies the same immutable evidence as current reads", () => {
  beforeEach(() => vi.clearAllMocks())

  it("keeps a qualified verdict READY on both evaluation and current read", async () => {
    setup()
    const result = await evaluateGateForTarget("ws", "target")
    const current = await getCurrentGateVerdict("ws", "target")
    expect(result?.verdict.state).toBe("READY")
    expect(current?.state).toBe("READY")
    expect(current?.historical.state).toBe("READY")
  })

  it("fails closed when a manifest exceeds the bounded producer read", async () => {
    const fixture = setup()
    fixture.bounds.manifestTooLarge = true
    const result = await evaluateGateForTarget("ws", "target")
    expect(result?.verdict.state).toBe("INSUFFICIENT_EVIDENCE")
    const tx = state.tx as { scan: { findFirst: ReturnType<typeof vi.fn> } }
    expect(tx.scan.findFirst.mock.calls[0]![0].select).not.toHaveProperty("resultManifest")
  })

  it.each(["missing checksum input", "corrupted checksum input", "coverage drift"] as const)(
    "does not return or persist READY for %s",
    async (condition) => {
      const fixture = setup()
      if (condition === "missing checksum input") fixture.resultManifest.checksumInput = null
      else if (condition === "corrupted checksum input") fixture.resultManifest.checksumInput += " "
      else fixture.rows[0]!.reason = "changed after manifest"

      const result = await evaluateGateForTarget("ws", "target")
      const current = await getCurrentGateVerdict("ws", "target")
      expect(result?.verdict.state).toBe("INSUFFICIENT_EVIDENCE")
      expect(current?.state).toBe("INSUFFICIENT_EVIDENCE")
      expect(current?.historical.state).toBe("INSUFFICIENT_EVIDENCE")
    }
  )
})
