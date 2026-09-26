import { z } from "zod"
import type { LyraShieldClient } from "../client"

/**
 * Shared response owner for `GET /api/v1/scans/eligibility`.
 *
 * The endpoint is an advisory read-only preflight: it evaluates the same
 * permission, plan, domain-proof and entitlement gates POST /api/scans
 * applies, without any trial, billing, scan or audit mutation. `allowed:false`
 * is a successful read carrying a structured denial — not a transport error —
 * and POST remains the authoritative gate (a pass here never guarantees
 * admission at creation time).
 */
export const ScanEligibilityBlockerSchema = z
  .object({
    code: z.string(),
    message: z.string(),
  })
  .passthrough()

export const ScanEligibilityOptionSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    goal: z.string(),
    mode: z.string(),
    workflow: z.string().optional(),
    available: z.boolean().optional(),
    disabledReason: z.string().nullable().optional(),
    usesAi: z.boolean().nullable().optional(),
    requiresRevisionInputs: z.boolean().optional(),
    authorizationHint: z.string().nullable().optional(),
  })
  .passthrough()

export const ScanEligibilitySchema = z
  .object({
    allowed: z.boolean(),
    code: z.string().nullable(),
    message: z.string().nullable(),
    plan: z.string(),
    isTrial: z.boolean(),
    remainingMinutes: z.number(),
    /** Server-resolved canonical review mode (input aliases normalized). */
    canonicalMode: z.string().nullable().optional(),
    /** Server-resolved review profile id (e.g. REPO_STANDARD, WEB_APP_DEEP). */
    canonicalProfileId: z.string().nullable().optional(),
    /**
     * The bounded list of review options the target currently offers —
     * server-projected from the same pure option policy the dashboard and
     * POST use; never a per-mode enumeration of this endpoint.
     */
    supportedModes: z.array(ScanEligibilityOptionSchema).optional(),
    /**
     * EXPECTED scanner-family coverage for the requested review. These are
     * admission-time expectations only — never a claim of completed coverage.
     */
    expectedScannerFamilies: z.array(z.string()).optional(),
    /** Machine-readable denial reasons, in the order POST would hit them. */
    blockers: z.array(ScanEligibilityBlockerSchema).optional(),
    /**
     * Evidence the preflight cannot establish without doing submission work
     * (e.g. ref resolution) — distinct from a denial.
     */
    limitations: z.array(z.string()).optional(),
  })
  .passthrough()

export type ScanEligibility = z.infer<typeof ScanEligibilitySchema>

export interface ScanEligibilityInput {
  workspaceId?: string
  targetId: string
  goal: string
  mode: string
  workflow?: "REVIEW_TARGET" | "REVIEW_CHANGES" | "AUTHENTICATED_ASSESSMENT"
  baseRef?: string
  headRef?: string
  attachmentIds?: string[]
  authorizationRef?: string
}

export function getScanEligibility(
  client: LyraShieldClient,
  input: ScanEligibilityInput,
  options?: { signal?: AbortSignal }
): Promise<ScanEligibility> {
  const params = new URLSearchParams()
  const workspaceId = input.workspaceId ?? client.workspaceId
  if (workspaceId) params.set("workspaceId", workspaceId)
  params.set("targetId", input.targetId)
  params.set("goal", input.goal)
  params.set("mode", input.mode)
  if (input.workflow) params.set("workflow", input.workflow)
  if (input.baseRef) params.set("baseRef", input.baseRef)
  if (input.headRef) params.set("headRef", input.headRef)
  for (const id of input.attachmentIds ?? []) params.append("attachmentIds", id)
  if (input.authorizationRef) params.set("authorizationRef", input.authorizationRef)
  return client.request("GET", `/scans/eligibility?${params.toString()}`, {
    signal: options?.signal,
    parse: (data) => ScanEligibilitySchema.parse(data),
  })
}
