import { z } from "zod"
import { resolveScanProfile } from "./scan-profile"
import { getUrlScanProfile } from "./url-scan-capabilities"

/**
 * Authoritative scan execution plan — the immutable, server-owned record of
 * what a scan is allowed to do. The server constructs and persists the plan
 * once, inside the same transaction that creates the scan; clients can never
 * supply the plan, its hash, internal budgets, provider routes, or
 * capabilities. The worker revalidates the stored plan at execution time.
 *
 * `lyrashield-scan-plan/1.0.0` contract:
 * - SHA fields accept only full 40- or 64-character lowercase git object IDs —
 *   abbreviated refs are rejected so a stored plan can never name a moving ref.
 * - REVIEW_CHANGES requires a REPO target, DIFF scope, and all three resolved
 *   revisions (head, requested base, effective merge base).
 * - AUTHENTICATED_ASSESSMENT requires a live WEB_APP/API target, DEEP depth,
 *   an authorization reference, and exactly the constrained beta ceilings —
 *   looser AND tighter values are both rejected (the ceilings are the
 *   contract, not a bound to interpret).
 */
export const SCAN_EXECUTION_PLAN_VERSION = "lyrashield-scan-plan/1.0.0" as const

export const ScanWorkflowSchema = z.enum([
  "REVIEW_TARGET",
  "REVIEW_CHANGES",
  "AUTHENTICATED_ASSESSMENT",
])
export type ScanWorkflow = z.infer<typeof ScanWorkflowSchema>

export const ScanPlanTargetTypeSchema = z.enum(["REPO", "WEB_APP", "API"])
export const ScanPlanDepthSchema = z.enum(["QUICK", "STANDARD", "DEEP"])
export const ScanPlanScopeSchema = z.enum(["SNAPSHOT", "DIFF", "LIVE"])

export type ScanPlanTargetType = z.infer<typeof ScanPlanTargetTypeSchema>
export type ScanPlanDepth = z.infer<typeof ScanPlanDepthSchema>
export type ScanPlanScope = z.infer<typeof ScanPlanScopeSchema>

/** Full-length lowercase git object IDs only (SHA-1 = 40 hex, SHA-256 = 64). */
const GitObjectIdSchema = z
  .string()
  .regex(
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/,
    "Expected a full 40- or 64-character lowercase git object ID"
  )

const ScanPlanSourceSchema = z
  .object({
    /** Immutable head revision the scan must check out. */
    revision: GitObjectIdSchema,
    /** Requested comparison base (Review Changes). */
    baseRevision: GitObjectIdSchema.optional(),
    /** Effective PR comparison base (merge base) resolved at creation. */
    mergeBaseRevision: GitObjectIdSchema.optional(),
  })
  .strict()

const ScanPlanLimitsSchema = z
  .object({
    maxDurationMs: z.number().int().positive(),
    maxEngineMs: z.number().int().nonnegative(),
    scannerReserveMs: z.number().int().nonnegative(),
    // Contract data, not a money column — a plain number is deliberate.
    maxBudgetUsd: z.number().finite().nonnegative(),
    maxRequests: z.number().int().positive().optional(),
    maxResponseBytes: z.number().int().positive().optional(),
  })
  .strict()

export type ScanPlanLimits = z.infer<typeof ScanPlanLimitsSchema>

/** Authenticated staging beta ceilings — 15 minutes total, 25 requests, 1 MiB
 * per response, $5 internal ceiling. Exact values, not bounds. */
export const AUTHENTICATED_ASSESSMENT_BETA_LIMITS = {
  maxDurationMs: 900_000,
  maxEngineMs: 720_000,
  scannerReserveMs: 180_000,
  maxBudgetUsd: 5,
  maxRequests: 25,
  maxResponseBytes: 1_048_576,
} as const

/**
 * Fixed path denylist for the authenticated staging beta. These are appended
 * to the workspace policy's own blockedPaths — the workflow permits only
 * explicitly approved GET/HEAD/OPTIONS reads, so well-known side-effectful
 * GET endpoints (logout, purchases, account deletion, admin, invitations) are
 * denied at the relay even when the policy does not name them. Prefixes are
 * normalized by the relay's path matcher before comparison.
 */
export const AUTHENTICATED_ASSESSMENT_DENIED_PATHS = [
  "/logout",
  "/log-out",
  "/signout",
  "/sign-out",
  "/checkout",
  "/cart",
  "/purchase",
  "/payment",
  "/pay",
  "/order",
  "/subscribe",
  "/unsubscribe",
  "/billing",
  "/invoice",
  "/upgrade",
  "/downgrade",
  "/delete",
  "/deactivate",
  "/destroy",
  "/admin",
  "/invite",
  "/account/delete",
  "/settings/billing",
  "/settings/delete",
  "/api/keys",
  "/api-keys",
] as const

export const ScanExecutionPlanSchema = z
  .object({
    version: z.literal(SCAN_EXECUTION_PLAN_VERSION),
    workflow: ScanWorkflowSchema,
    targetType: ScanPlanTargetTypeSchema,
    depth: ScanPlanDepthSchema,
    profileId: z.string().min(1).max(128),
    scope: ScanPlanScopeSchema,
    source: ScanPlanSourceSchema.optional(),
    limits: ScanPlanLimitsSchema,
    capabilities: z.array(z.string().min(1).max(64)).max(32),
    attachmentIds: z.array(z.string().min(1).max(128)).max(20),
    authorizationRef: z.string().min(1).max(256).optional(),
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (plan.limits.maxEngineMs + plan.limits.scannerReserveMs > plan.limits.maxDurationMs) {
      ctx.addIssue({
        code: "custom",
        path: ["limits"],
        message: "Engine and scanner reserve budgets cannot exceed the total duration",
      })
    }

    if (plan.workflow === "REVIEW_TARGET") {
      // A repository review runs against a checked-out snapshot; a live-target
      // review runs against the live WEB_APP/API origin. Anything else is an
      // inconsistent scope/workflow pair.
      const expectedScope = plan.targetType === "REPO" ? "SNAPSHOT" : "LIVE"
      if (plan.scope !== expectedScope) {
        ctx.addIssue({
          code: "custom",
          path: ["scope"],
          message: `REVIEW_TARGET on ${plan.targetType} requires ${expectedScope} scope`,
        })
      }
    }

    if (plan.workflow === "REVIEW_CHANGES") {
      if (plan.targetType !== "REPO") {
        ctx.addIssue({
          code: "custom",
          path: ["targetType"],
          message: "REVIEW_CHANGES requires a REPO target",
        })
      }
      if (plan.scope !== "DIFF") {
        ctx.addIssue({
          code: "custom",
          path: ["scope"],
          message: "REVIEW_CHANGES requires DIFF scope",
        })
      }
      if (
        !plan.source?.revision ||
        !plan.source?.baseRevision ||
        !plan.source?.mergeBaseRevision
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["source"],
          message:
            "REVIEW_CHANGES requires resolved revision, baseRevision, and mergeBaseRevision",
        })
      }
    }

    if (plan.workflow === "AUTHENTICATED_ASSESSMENT") {
      if (plan.targetType !== "WEB_APP" && plan.targetType !== "API") {
        ctx.addIssue({
          code: "custom",
          path: ["targetType"],
          message: "AUTHENTICATED_ASSESSMENT requires a live WEB_APP or API target",
        })
      }
      if (plan.depth !== "DEEP") {
        ctx.addIssue({
          code: "custom",
          path: ["depth"],
          message: "AUTHENTICATED_ASSESSMENT requires the DEEP preset",
        })
      }
      if (plan.scope !== "LIVE") {
        ctx.addIssue({
          code: "custom",
          path: ["scope"],
          message: "AUTHENTICATED_ASSESSMENT requires LIVE scope",
        })
      }
      if (!plan.authorizationRef) {
        ctx.addIssue({
          code: "custom",
          path: ["authorizationRef"],
          message: "AUTHENTICATED_ASSESSMENT requires an authorization reference",
        })
      }
      // Exact beta ceilings — reject looser AND tighter values.
      const beta = AUTHENTICATED_ASSESSMENT_BETA_LIMITS
      const ceilings: Array<[keyof ScanPlanLimits, number]> = [
        ["maxDurationMs", beta.maxDurationMs],
        ["maxRequests", beta.maxRequests],
        ["maxResponseBytes", beta.maxResponseBytes],
        ["maxBudgetUsd", beta.maxBudgetUsd],
      ]
      for (const [field, expected] of ceilings) {
        if (plan.limits[field] !== expected) {
          ctx.addIssue({
            code: "custom",
            path: ["limits", field],
            message: `AUTHENTICATED_ASSESSMENT requires exactly ${expected} for ${String(field)}`,
          })
        }
      }
    }
  })

export type ScanExecutionPlan = z.infer<typeof ScanExecutionPlanSchema>

/** Error thrown when server-side inputs cannot produce a valid plan. The API
 * layer maps this to a 400 rather than a generic 500. */
export class ScanExecutionPlanInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ScanExecutionPlanInputError"
  }
}

/** Canonical depth for a stored/requested scan mode (SAFE→QUICK, CUSTOM→DEEP). */
export function normalizePlanDepth(mode: string): ScanPlanDepth | null {
  const normalized = mode.trim().toUpperCase()
  if (normalized === "SAFE" || normalized === "QUICK") return "QUICK"
  if (normalized === "STANDARD") return "STANDARD"
  if (normalized === "DEEP" || normalized === "CUSTOM") return "DEEP"
  return null
}

const REPO_SOURCE_CAPABILITIES = [
  "sca",
  "secrets",
  "sast",
  "iac",
  "agent_config",
  "ai_app_security",
  "ml_supply_chain",
] as const

export interface BuildScanExecutionPlanInput {
  /** Optional workflow selection; defaults to REVIEW_TARGET. */
  workflow?: ScanWorkflow
  /** Trusted stored target type — never client-supplied plan data. */
  targetType: string
  /** Scan mode as persisted on the Scan row (aliases canonicalize). */
  mode: string
  /** Deterministic-only retest: no engine execution is planned. */
  deterministicOnly?: boolean
  /** Resolved immutable revisions; required for REVIEW_CHANGES. */
  source?: { revision: string; baseRevision?: string; mergeBaseRevision?: string }
  attachmentIds?: string[]
  authorizationRef?: string
}

/**
 * Build and validate the authoritative plan for a scan being created. All
 * trusted fields (targetType, depth, profile, limits, capabilities) derive
 * from the shared profile registry — the caller supplies only workflow and
 * already-resolved provenance, never limits or capabilities directly.
 */
export function buildScanExecutionPlan(
  input: BuildScanExecutionPlanInput
): ScanExecutionPlan {
  const workflow: ScanWorkflow = input.workflow ?? "REVIEW_TARGET"
  const targetType = ScanPlanTargetTypeSchema.safeParse(input.targetType)
  if (!targetType.success) {
    throw new ScanExecutionPlanInputError("TARGET_TYPE_UNSUPPORTED")
  }

  let profile
  try {
    profile = resolveScanProfile({ targetType: targetType.data, mode: input.mode })
  } catch (error) {
    throw new ScanExecutionPlanInputError(
      error instanceof Error ? error.message : "SCAN_MODE_UNSUPPORTED"
    )
  }

  const depth = normalizePlanDepth(profile.canonicalMode)
  if (!depth) throw new ScanExecutionPlanInputError("SCAN_MODE_UNSUPPORTED")

  const isLiveTarget = targetType.data === "WEB_APP" || targetType.data === "API"
  const scope: ScanPlanScope =
    workflow === "REVIEW_CHANGES" ? "DIFF" : isLiveTarget ? "LIVE" : "SNAPSHOT"

  const deterministicOnly = input.deterministicOnly === true
  const capabilities: string[] =
    targetType.data === "REPO"
      ? deterministicOnly
        ? [...REPO_SOURCE_CAPABILITIES]
        : ["engine", ...REPO_SOURCE_CAPABILITIES]
      : profile.usesAi
        ? ["engine", "url"]
        : ["url"]

  const limits: ScanPlanLimits =
    workflow === "AUTHENTICATED_ASSESSMENT"
      ? { ...AUTHENTICATED_ASSESSMENT_BETA_LIMITS }
      : {
          maxDurationMs: profile.maxDurationMinutes * 60_000,
          maxEngineMs: profile.maxEngineMinutes * 60_000,
          scannerReserveMs: profile.scannerReserveMinutes * 60_000,
          maxBudgetUsd: profile.maxBudgetUsd,
          ...(isLiveTarget
            ? {
                maxResponseBytes: getUrlScanProfile(
                  targetType.data as "WEB_APP" | "API",
                  input.mode
                ).maxResponseBytes,
              }
            : {}),
        }

  const parsed = ScanExecutionPlanSchema.safeParse({
    version: SCAN_EXECUTION_PLAN_VERSION,
    workflow,
    targetType: targetType.data,
    depth,
    profileId: profile.id,
    scope,
    ...(input.source ? { source: input.source } : {}),
    limits,
    capabilities,
    attachmentIds: input.attachmentIds ?? [],
    ...(input.authorizationRef ? { authorizationRef: input.authorizationRef } : {}),
  })

  if (!parsed.success) {
    throw new ScanExecutionPlanInputError(
      parsed.error.issues.map((issue) => issue.message).join("; ")
    )
  }
  return parsed.data
}
