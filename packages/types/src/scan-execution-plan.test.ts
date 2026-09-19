import { describe, expect, it } from "vitest"
import {
  AUTHENTICATED_ASSESSMENT_BETA_LIMITS,
  buildScanExecutionPlan,
  normalizePlanDepth,
  ScanExecutionPlanSchema,
} from "./scan-execution-plan"

const HEAD = "a".repeat(40)
const BASE = "b".repeat(40)
const MERGE_BASE = "c".repeat(40)

const REPO_SNAPSHOT_PLAN = {
  version: "lyrashield-scan-plan/1.0.0",
  workflow: "REVIEW_TARGET",
  targetType: "REPO",
  depth: "STANDARD",
  profileId: "REPO_STANDARD",
  scope: "SNAPSHOT",
  source: { revision: HEAD },
  limits: {
    maxDurationMs: 900_000,
    maxEngineMs: 720_000,
    scannerReserveMs: 180_000,
    maxBudgetUsd: 3.2,
  },
  capabilities: ["engine", "sca", "secrets"],
  attachmentIds: [],
}

const LIVE_PLAN = {
  version: "lyrashield-scan-plan/1.0.0",
  workflow: "REVIEW_TARGET",
  targetType: "WEB_APP",
  depth: "STANDARD",
  profileId: "WEB_APP_STANDARD",
  scope: "LIVE",
  limits: {
    maxDurationMs: 900_000,
    maxEngineMs: 720_000,
    scannerReserveMs: 180_000,
    maxBudgetUsd: 3.2,
    maxResponseBytes: 3 * 1024 * 1024,
  },
  capabilities: ["engine", "url"],
  attachmentIds: [],
}

const REVIEW_CHANGES_PLAN = {
  ...REPO_SNAPSHOT_PLAN,
  workflow: "REVIEW_CHANGES",
  scope: "DIFF",
  depth: "QUICK",
  profileId: "REPO_QUICK",
  source: { revision: HEAD, baseRevision: BASE, mergeBaseRevision: MERGE_BASE },
}

const AUTHENTICATED_PLAN = {
  version: "lyrashield-scan-plan/1.0.0",
  workflow: "AUTHENTICATED_ASSESSMENT",
  targetType: "WEB_APP",
  depth: "DEEP",
  profileId: "WEB_APP_DEEP",
  scope: "LIVE",
  limits: { ...AUTHENTICATED_ASSESSMENT_BETA_LIMITS },
  capabilities: ["engine", "url"],
  attachmentIds: [],
  authorizationRef: "authz_123",
}

describe("ScanExecutionPlanSchema", () => {
  it("accepts a well-formed repository snapshot plan", () => {
    expect(ScanExecutionPlanSchema.safeParse(REPO_SNAPSHOT_PLAN).success).toBe(true)
    expect(ScanExecutionPlanSchema.safeParse(LIVE_PLAN).success).toBe(true)
  })

  it("enforces the contract version literal", () => {
    for (const version of ["lyrashield-scan-plan/0.9.0", "lyrashield-scan-plan/2.0.0", ""]) {
      expect(ScanExecutionPlanSchema.safeParse({ ...REPO_SNAPSHOT_PLAN, version }).success).toBe(
        false
      )
    }
  })

  it("rejects abbreviated and non-lowercase refs in stored source fields", () => {
    const withAbbrev = {
      ...REPO_SNAPSHOT_PLAN,
      source: { revision: "1689f36" },
    }
    expect(ScanExecutionPlanSchema.safeParse(withAbbrev).success).toBe(false)

    const withUpper = {
      ...REPO_SNAPSHOT_PLAN,
      source: { revision: "A".repeat(40) },
    }
    expect(ScanExecutionPlanSchema.safeParse(withUpper).success).toBe(false)

    const withBranch = {
      ...REPO_SNAPSHOT_PLAN,
      source: { revision: "refs/heads/main" },
    }
    expect(ScanExecutionPlanSchema.safeParse(withBranch).success).toBe(false)

    const with64 = {
      ...REPO_SNAPSHOT_PLAN,
      source: { revision: "d".repeat(64) },
    }
    expect(ScanExecutionPlanSchema.safeParse(with64).success).toBe(true)
  })

  it("rejects plans with unknown fields", () => {
    expect(
      ScanExecutionPlanSchema.safeParse({ ...REPO_SNAPSHOT_PLAN, providerRoute: "x" }).success
    ).toBe(false)
    expect(
      ScanExecutionPlanSchema.safeParse({
        ...REPO_SNAPSHOT_PLAN,
        limits: { ...REPO_SNAPSHOT_PLAN.limits, internalBudget: 99 },
      }).success
    ).toBe(false)
  })

  it("rejects engine + reserve budgets that exceed the total duration", () => {
    const plan = {
      ...REPO_SNAPSHOT_PLAN,
      limits: { ...REPO_SNAPSHOT_PLAN.limits, maxEngineMs: 900_000 },
    }
    expect(ScanExecutionPlanSchema.safeParse(plan).success).toBe(false)
  })

  // Negative contract example from the production handoff (Task 5), verbatim.
  it("rejects REVIEW_CHANGES without immutable source comparison", () => {
    expect(
      ScanExecutionPlanSchema.safeParse({
        version: "lyrashield-scan-plan/1.0.0",
        workflow: "REVIEW_CHANGES",
        targetType: "REPO",
        depth: "QUICK",
        profileId: "REPO_QUICK",
        scope: "DIFF",
        limits: {
          maxDurationMs: 900000,
          maxEngineMs: 720000,
          scannerReserveMs: 180000,
          maxBudgetUsd: 1.2,
        },
        capabilities: [],
        attachmentIds: [],
      }).success
    ).toBe(false) // missing immutable source comparison
  })

  describe("REVIEW_CHANGES", () => {
    it("requires REPO target, DIFF scope, and all three resolved revisions", () => {
      expect(ScanExecutionPlanSchema.safeParse(REVIEW_CHANGES_PLAN).success).toBe(true)
    })

    it("rejects non-REPO targets", () => {
      expect(
        ScanExecutionPlanSchema.safeParse({ ...REVIEW_CHANGES_PLAN, targetType: "WEB_APP" }).success
      ).toBe(false)
    })

    it("rejects SNAPSHOT scope", () => {
      expect(
        ScanExecutionPlanSchema.safeParse({ ...REVIEW_CHANGES_PLAN, scope: "SNAPSHOT" }).success
      ).toBe(false)
    })

    it.each(["baseRevision", "mergeBaseRevision"] as const)("rejects a missing %s", (field) => {
      const source = { ...REVIEW_CHANGES_PLAN.source } as Record<string, string>
      delete source[field]
      expect(ScanExecutionPlanSchema.safeParse({ ...REVIEW_CHANGES_PLAN, source }).success).toBe(
        false
      )
    })
  })

  describe("REVIEW_TARGET scope pairing", () => {
    it("requires SNAPSHOT scope for REPO and LIVE scope for live targets", () => {
      expect(
        ScanExecutionPlanSchema.safeParse({ ...REPO_SNAPSHOT_PLAN, scope: "LIVE" }).success
      ).toBe(false)
      expect(ScanExecutionPlanSchema.safeParse({ ...LIVE_PLAN, scope: "SNAPSHOT" }).success).toBe(
        false
      )
    })
  })

  describe("AUTHENTICATED_ASSESSMENT", () => {
    it("accepts the exact constrained beta ceilings", () => {
      expect(ScanExecutionPlanSchema.safeParse(AUTHENTICATED_PLAN).success).toBe(true)
    })

    it.each([
      ["maxDurationMs", 900_001],
      ["maxDurationMs", 899_999],
      ["maxRequests", 26],
      ["maxRequests", 24],
      ["maxResponseBytes", 1_048_577],
      ["maxResponseBytes", 1_048_575],
      ["maxBudgetUsd", 5.01],
      ["maxBudgetUsd", 4.99],
    ] as const)("rejects %s = %d (looser or tighter than the beta ceiling)", (field, value) => {
      const limits = { ...AUTHENTICATED_PLAN.limits, [field]: value }
      expect(ScanExecutionPlanSchema.safeParse({ ...AUTHENTICATED_PLAN, limits }).success).toBe(
        false
      )
    })

    it("rejects omitted optional ceilings", () => {
      const limits = { ...AUTHENTICATED_PLAN.limits } as Record<string, unknown>
      delete limits["maxRequests"]
      expect(ScanExecutionPlanSchema.safeParse({ ...AUTHENTICATED_PLAN, limits }).success).toBe(
        false
      )
    })

    it("requires a live WEB_APP/API target, DEEP depth, and an authorizationRef", () => {
      expect(
        ScanExecutionPlanSchema.safeParse({ ...AUTHENTICATED_PLAN, targetType: "REPO" }).success
      ).toBe(false)
      expect(
        ScanExecutionPlanSchema.safeParse({ ...AUTHENTICATED_PLAN, depth: "STANDARD" }).success
      ).toBe(false)
      expect(
        ScanExecutionPlanSchema.safeParse({ ...AUTHENTICATED_PLAN, scope: "SNAPSHOT" }).success
      ).toBe(false)
      const noAuth: Record<string, unknown> = { ...AUTHENTICATED_PLAN }
      delete noAuth["authorizationRef"]
      expect(ScanExecutionPlanSchema.safeParse(noAuth).success).toBe(false)
    })
  })
})

describe("normalizePlanDepth", () => {
  it("canonicalizes legacy and current modes", () => {
    expect(normalizePlanDepth("SAFE")).toBe("QUICK")
    expect(normalizePlanDepth("QUICK")).toBe("QUICK")
    expect(normalizePlanDepth("STANDARD")).toBe("STANDARD")
    expect(normalizePlanDepth("DEEP")).toBe("DEEP")
    expect(normalizePlanDepth("CUSTOM")).toBe("DEEP")
    expect(normalizePlanDepth("bogus")).toBeNull()
  })
})

describe("buildScanExecutionPlan", () => {
  it("builds a server-owned REVIEW_TARGET snapshot plan for a repo scan", () => {
    const plan = buildScanExecutionPlan({ targetType: "REPO", mode: "STANDARD" })
    expect(plan).toMatchObject({
      version: "lyrashield-scan-plan/1.0.0",
      workflow: "REVIEW_TARGET",
      targetType: "REPO",
      depth: "STANDARD",
      profileId: "REPO_STANDARD",
      scope: "SNAPSHOT",
      limits: {
        maxDurationMs: 900_000,
        maxEngineMs: 720_000,
        scannerReserveMs: 180_000,
        maxBudgetUsd: 3.2,
      },
    })
    expect(plan.capabilities).toContain("engine")
    expect(plan.capabilities).toContain("sca")
  })

  it("builds a live-target plan for URL scans", () => {
    const plan = buildScanExecutionPlan({ targetType: "WEB_APP", mode: "SAFE" })
    expect(plan).toMatchObject({
      workflow: "REVIEW_TARGET",
      targetType: "WEB_APP",
      depth: "QUICK",
      profileId: "WEB_APP_SAFE",
      scope: "LIVE",
    })
    expect(plan.capabilities).toEqual(["url"])
    expect(plan.limits.maxBudgetUsd).toBe(0)
    expect(plan.limits.maxResponseBytes).toBe(3 * 1024 * 1024)
  })

  it("excludes the engine capability for deterministic-only retests", () => {
    const plan = buildScanExecutionPlan({
      targetType: "REPO",
      mode: "QUICK",
      deterministicOnly: true,
    })
    expect(plan.capabilities).not.toContain("engine")
  })

  it("passes resolved immutable provenance through for REVIEW_CHANGES", () => {
    const plan = buildScanExecutionPlan({
      workflow: "REVIEW_CHANGES",
      targetType: "REPO",
      mode: "QUICK",
      source: { revision: HEAD, baseRevision: BASE, mergeBaseRevision: MERGE_BASE },
    })
    expect(plan).toMatchObject({
      workflow: "REVIEW_CHANGES",
      scope: "DIFF",
      source: { revision: HEAD, baseRevision: BASE, mergeBaseRevision: MERGE_BASE },
    })
  })

  it("refuses REVIEW_CHANGES without resolved provenance", () => {
    expect(() =>
      buildScanExecutionPlan({ workflow: "REVIEW_CHANGES", targetType: "REPO", mode: "QUICK" })
    ).toThrow(/revision/i)
  })

  it("pins the exact beta ceilings for AUTHENTICATED_ASSESSMENT", () => {
    const plan = buildScanExecutionPlan({
      workflow: "AUTHENTICATED_ASSESSMENT",
      targetType: "API",
      mode: "DEEP",
      authorizationRef: "authz_1",
    })
    expect(plan.limits).toEqual({ ...AUTHENTICATED_ASSESSMENT_BETA_LIMITS })
    expect(plan.scope).toBe("LIVE")
    expect(plan.depth).toBe("DEEP")
  })

  it("rejects target types outside the plan contract", () => {
    expect(() => buildScanExecutionPlan({ targetType: "CLOUD_ACCOUNT", mode: "QUICK" })).toThrow(
      "TARGET_TYPE_UNSUPPORTED"
    )
    expect(() => buildScanExecutionPlan({ targetType: "REPO", mode: "EXPENSIVE" })).toThrow(
      "SCAN_MODE_UNSUPPORTED"
    )
  })
})
