import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { getOnboardingReviewOptions } from "./onboarding-flow.utils"
import {
  checkPendingScanOperation,
  runCreateTargetAndStart,
  type ScanFlowContext,
} from "./onboarding-scan-flow"
import type { PendingScanSubmission } from "@/lib/scan-submission"

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }))
vi.mock("@/lib/api-client", async (original) => ({
  ...(await original<typeof import("@/lib/api-client")>()),
  apiGet: api.get,
  apiPost: api.post,
}))

function context(): ScanFlowContext {
  const data = {
    currentStep: 3,
    completed: false,
    skipped: false,
    workspaceId: null,
    targetId: null,
    selectedGoal: null,
  }
  return {
    principalId: "user-1",
    data,
    path: "url",
    selectedRepo: null,
    productName: "Staging site",
    urlForm: { url: "https://example.test", ownershipAttested: true },
    environment: "STAGING",
    selectedReview: getOnboardingReviewOptions("url")[0],
    completionPath: "/dashboard",
    oauthReturnQuery: null,
    router: {
      bfcacheId: "onboarding-test",
      push: vi.fn(),
      refresh: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      replace: vi.fn(),
      prefetch: vi.fn(),
    },
    persist: vi.fn(async (updates) => ({ ...data, ...updates })),
    ensureWorkspace: vi.fn(async () => "ws-new"),
    setLoading: vi.fn(),
    setError: vi.fn(),
    setFailure: vi.fn(),
    scanSubmissionLock: { current: false },
    startNewScanAfterPreflight: { current: false },
    targetRecovery: { current: null },
    trialStart: { current: { confirmed: null, unknown: null } },
    checkedEligibilityKey: null,
    setCheckedEligibilityKey: vi.fn(),
    scanEligibility: { status: "idle" },
    setScanEligibility: vi.fn(),
    setPendingScanSubmission: vi.fn(),
    setScanOperationStatus: vi.fn(),
    setCheckingScanOperation: vi.fn(),
    setScanRecoveryError: vi.fn(),
    setScanRecoveryUnavailable: vi.fn(),
    persistedTargetReusable: false,
    onTargetBound: vi.fn(),
  }
}

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  })
  api.get.mockReset().mockResolvedValue({
    allowed: true,
    code: null,
    message: null,
    plan: "TRIAL",
    isTrial: true,
    remainingMinutes: 120,
  })
  api.post.mockReset().mockImplementation(async (url: string) => {
    if (url === "/api/targets") return { id: "target-new" }
    if (url === "/api/scans") return { id: "scan-new" }
    throw new Error(`Unexpected POST ${url}`)
  })
})
afterEach(() => vi.unstubAllGlobals())

it("locks restored-session workspace preparation before a second Start click", async () => {
  const ctx = context()
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  ctx.ensureWorkspace = vi.fn(async () => {
    await held
    return "ws-new"
  })
  const first = runCreateTargetAndStart(ctx)
  const second = runCreateTargetAndStart(ctx)
  const preparations = vi.mocked(ctx.ensureWorkspace).mock.calls.length
  release()
  await Promise.all([first, second])
  expect(preparations).toBe(1)
  expect(api.post.mock.calls.filter(([url]) => url === "/api/scans")).toHaveLength(1)
  expect(ctx.scanSubmissionLock.current).toBe(false)
})

it("carries the newly prepared workspace through accepted-scan completion", async () => {
  const ctx = context()
  await runCreateTargetAndStart(ctx)
  expect(ctx.router.push).toHaveBeenCalledWith("/dashboard/scans/scan-new")
  expect(ctx.persist).toHaveBeenLastCalledWith(
    expect.objectContaining({ completed: true, workspaceId: "ws-new" })
  )
})

it("does not prepare a workspace until a scan goal has been chosen", async () => {
  const ctx = context()
  ctx.selectedReview = undefined
  await runCreateTargetAndStart(ctx)
  expect(ctx.setError).toHaveBeenCalledWith("Choose a goal for this review.")
  expect(ctx.ensureWorkspace).not.toHaveBeenCalled()
  expect(api.post).not.toHaveBeenCalled()
})

it("releases the Start lock after workspace preparation fails so the user can retry", async () => {
  const ctx = context()
  ctx.ensureWorkspace = vi
    .fn()
    .mockRejectedValueOnce(new Error("Workspace unavailable"))
    .mockResolvedValueOnce("ws-new")
  await runCreateTargetAndStart(ctx)
  expect(ctx.setError).toHaveBeenCalledWith("Workspace unavailable")
  expect(ctx.setLoading).toHaveBeenLastCalledWith(false)
  expect(api.post).not.toHaveBeenCalled()
  await runCreateTargetAndStart(ctx)
  expect(ctx.router.push).toHaveBeenCalledWith("/dashboard/scans/scan-new")
})

it("retains a known failed scan ID and lets the user view its status", async () => {
  const ctx = context()
  ctx.data.workspaceId = "ws-1"
  const submission: PendingScanSubmission = {
    version: 1,
    principalId: "user-1",
    workspaceId: "ws-1",
    surface: "onboarding",
    requestIdentity: "{}",
    idempotencyKey: "00000000-0000-4000-8000-000000000001",
    state: "pending",
    operationId: "operation-1",
  }
  api.get.mockResolvedValueOnce({
    operationId: "operation-1",
    status: "FAILED",
    reasonCode: "SCAN_FAILED",
    resultLocation: "scan-failed-1",
    recovery: "retry_new_key",
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:01:00.000Z",
  })

  await checkPendingScanOperation(ctx, submission)

  expect(ctx.setPendingScanSubmission).toHaveBeenCalledWith(
    expect.objectContaining({ state: "accepted", scanId: "scan-failed-1" })
  )
  expect(ctx.setScanRecoveryError).toHaveBeenCalledWith(
    "This scan ended with an error. View its status and details before starting another."
  )
})
