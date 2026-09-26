import { beforeEach, describe, expect, it, vi } from "vitest"

const configMocks = vi.hoisted(() => ({
  authAssessment: { enabled: "0", allowlist: "" },
}))

vi.mock("@lyrashield/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lyrashield/config")>()
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(target, prop) {
        if (prop === "LYRASHIELD_AUTH_ASSESSMENT_ENABLED") {
          return configMocks.authAssessment.enabled
        }
        if (prop === "LYRASHIELD_AUTH_ASSESSMENT_ALLOWLIST") {
          return configMocks.authAssessment.allowlist
        }
        return Reflect.get(target, prop)
      },
    }),
  }
})

vi.mock("@lyrashield/db", () => ({
  prisma: {
    targetDomainVerification: { findFirst: vi.fn() },
    policy: { findFirst: vi.fn() },
  },
}))

vi.mock("@lyrashield/billing", () => ({
  resolveWorkspaceScanSponsor: vi.fn(),
  resolveAccountBilling: vi.fn(),
}))

import { prisma } from "@lyrashield/db"
import { resolveAccountBilling, resolveWorkspaceScanSponsor } from "@lyrashield/billing"
import {
  authAssessmentAdmission,
  findCurrentDomainProof,
  findScanPolicy,
  listAdmissibleReviewOptions,
  matchReviewOption,
  resolveCanonicalReviewMode,
  resolveSponsorScanPlan,
  resolveUrlReviewMode,
} from "./scan-admission"

describe("resolveUrlReviewMode", () => {
  it("marks engine-backed URL tiers and never touches other target types", () => {
    expect(
      resolveUrlReviewMode({ targetType: "WEB_APP", mode: "STANDARD", hasApiSpec: false })
    ).toEqual({ ok: true, engineBacked: true })
    expect(
      resolveUrlReviewMode({ targetType: "WEB_APP", mode: "SAFE", hasApiSpec: false })
    ).toEqual({ ok: true, engineBacked: false })
    expect(
      resolveUrlReviewMode({ targetType: "REPO", mode: "STANDARD", hasApiSpec: false })
    ).toEqual({ ok: true, engineBacked: false })
  })

  it("fails closed with the availability code POST would return", () => {
    expect(
      resolveUrlReviewMode({ targetType: "API", mode: "STANDARD", hasApiSpec: false })
    ).toMatchObject({ ok: false, code: "API_SPEC_REQUIRED" })
    expect(resolveUrlReviewMode({ targetType: "API", mode: "STANDARD", hasApiSpec: true })).toEqual(
      { ok: true, engineBacked: true }
    )
    expect(
      resolveUrlReviewMode({ targetType: "WEB_APP", mode: "MASSIVE", hasApiSpec: false })
    ).toMatchObject({ ok: false, code: "URL_MODE_UNSUPPORTED" })
  })
})

describe("resolveCanonicalReviewMode", () => {
  it("maps aliases to the canonical mode and profile id", () => {
    expect(resolveCanonicalReviewMode({ targetType: "REPO", mode: "SAFE" })).toEqual({
      ok: true,
      canonicalMode: "QUICK",
      profileId: "REPO_QUICK",
    })
    expect(resolveCanonicalReviewMode({ targetType: "REPO", mode: "CUSTOM" })).toEqual({
      ok: true,
      canonicalMode: "DEEP",
      profileId: "REPO_DEEP",
    })
    expect(resolveCanonicalReviewMode({ targetType: "API", mode: "DEEP" })).toEqual({
      ok: true,
      canonicalMode: "DEEP",
      profileId: "API_DEEP",
    })
  })

  it("returns the same failure codes POST reports", () => {
    expect(resolveCanonicalReviewMode({ targetType: "REPO", mode: "MASSIVE" as never })).toEqual({
      ok: false,
      code: "SCAN_MODE_UNSUPPORTED",
    })
    expect(resolveCanonicalReviewMode({ targetType: "SATELLITE", mode: "SAFE" })).toEqual({
      ok: false,
      code: "TARGET_TYPE_UNSUPPORTED",
    })
  })
})

describe("resolveSponsorScanPlan", () => {
  beforeEach(() => vi.clearAllMocks())

  it("reads the sponsor account's effective plan, never the workspace mirror", async () => {
    vi.mocked(resolveWorkspaceScanSponsor).mockResolvedValue({
      accountId: "user-1",
      agency: false,
      agencyActive: false,
    })
    vi.mocked(resolveAccountBilling).mockResolvedValue({
      effectivePlan: "PRO",
      currentPlan: "PRO",
    } as never)

    await expect(resolveSponsorScanPlan("ws-1", "user-1")).resolves.toBe("PRO")
    expect(resolveAccountBilling).toHaveBeenCalledWith("user-1")
  })

  it("treats an active agency sponsor as LAUNCH_ASSURANCE without a billing read", async () => {
    vi.mocked(resolveWorkspaceScanSponsor).mockResolvedValue({
      accountId: "agency-1",
      agency: true,
      agencyActive: true,
    })

    await expect(resolveSponsorScanPlan("ws-1", "user-1")).resolves.toBe("LAUNCH_ASSURANCE")
    expect(resolveAccountBilling).not.toHaveBeenCalled()
  })

  it("falls back to FREE when billing cannot be resolved", async () => {
    vi.mocked(resolveWorkspaceScanSponsor).mockResolvedValue(null as never)
    vi.mocked(resolveAccountBilling).mockResolvedValue(null as never)

    await expect(resolveSponsorScanPlan("ws-1", "user-1")).resolves.toBe("FREE")
  })
})

describe("findCurrentDomainProof", () => {
  beforeEach(() => vi.clearAllMocks())

  it("normalizes the target URL and reports a current proof only", async () => {
    vi.mocked(prisma.targetDomainVerification.findFirst).mockResolvedValue({
      id: "proof-1",
    } as never)

    const result = await findCurrentDomainProof("ws-1", "https://App.Example.com/path?q=1")
    expect(result).toEqual({ domain: "app.example.com", verified: true })
    expect(prisma.targetDomainVerification.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: "ws-1",
        domain: "app.example.com",
        status: "VERIFIED",
        expiresAt: { gt: expect.any(Date) },
      },
      select: { id: true },
    })
  })

  it("reports unverified for absent URLs or missing proofs", async () => {
    vi.mocked(prisma.targetDomainVerification.findFirst).mockResolvedValue(null as never)

    expect(await findCurrentDomainProof("ws-1", null)).toEqual({
      domain: null,
      verified: false,
    })
    expect(await findCurrentDomainProof("ws-1", "https://a.example.com")).toEqual({
      domain: "a.example.com",
      verified: false,
    })
  })
})

describe("findScanPolicy", () => {
  beforeEach(() => vi.clearAllMocks())

  it("uses the explicit policy id or the workspace default", async () => {
    vi.mocked(prisma.policy.findFirst).mockResolvedValue({ id: "p-1" } as never)

    await findScanPolicy("ws-1", "p-9")
    expect(prisma.policy.findFirst).toHaveBeenCalledWith({
      where: { id: "p-9", workspaceId: "ws-1", deletedAt: null },
      orderBy: undefined,
      select: { id: true, destructiveTestsAllowed: true },
    })

    await findScanPolicy("ws-1")
    expect(prisma.policy.findFirst).toHaveBeenLastCalledWith({
      where: { workspaceId: "ws-1", name: "Default Policy", deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, destructiveTestsAllowed: true },
    })
  })
})

describe("authAssessmentAdmission", () => {
  beforeEach(() => {
    configMocks.authAssessment.enabled = "0"
    configMocks.authAssessment.allowlist = ""
  })

  it("fails closed unless flag and allowlist both admit the pair", () => {
    expect(authAssessmentAdmission("ws-1", "t-1").allowed).toBe(false)
    configMocks.authAssessment.enabled = "1"
    expect(authAssessmentAdmission("ws-1", "t-1").allowed).toBe(false)
    configMocks.authAssessment.allowlist = "ws-1:t-1,ws-2"
    expect(authAssessmentAdmission("ws-1", "t-1").allowed).toBe(true)
    expect(authAssessmentAdmission("ws-2", "t-9").allowed).toBe(true)
    expect(authAssessmentAdmission("ws-2", "t-1").allowed).toBe(true)
    expect(authAssessmentAdmission("ws-3", "t-1").allowed).toBe(false)
  })
})

describe("listAdmissibleReviewOptions / matchReviewOption", () => {
  it("derives the bounded option list for each target kind", () => {
    const repo = listAdmissibleReviewOptions({ type: "REPO" })
    expect(repo.map((o) => o.id)).toContain("REVIEW_CHANGES")
    const api = listAdmissibleReviewOptions({ type: "API", hasApiSpec: false })
    expect(api.find((o) => o.id === "API_STANDARD")?.available).toBe(false)
    expect(api.find((o) => o.id === "API_STANDARD")?.disabledReason).toContain("OpenAPI")
  })

  it("matches the requested review to the option that owns its coverage", () => {
    const repo = listAdmissibleReviewOptions({ type: "REPO" })
    // REVIEW_CHANGES pins the diff preset over the same-depth default.
    expect(
      matchReviewOption(repo, { canonicalMode: "QUICK", workflow: "REVIEW_CHANGES" })?.id
    ).toBe("REVIEW_CHANGES")
    expect(matchReviewOption(repo, { canonicalMode: "STANDARD" })?.id).toBe("CODE_REVIEW")

    const web = listAdmissibleReviewOptions({ type: "WEB_APP" })
    // URL profiles share ids with their options — the profile match wins.
    expect(matchReviewOption(web, { profileId: "WEB_APP_DEEP" })?.id).toBe("WEB_APP_DEEP")
    expect(matchReviewOption(web, { profileId: "WEB_APP_NOPE", canonicalMode: "SAFE" })?.id).toBe(
      "WEB_APP_SAFE"
    )
  })
})
