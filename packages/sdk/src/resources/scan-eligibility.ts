import { z } from "zod"
import type { LyraShieldClient } from "../client"
import { ScanEligibilitySchema } from "../schemas"

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

const ScanEligibilityInputSchema = z
  .object({
    workspaceId: z.string().min(1).optional(),
    targetId: z.string().min(1).max(128),
    goal: z.enum([
      "CHECK_PR",
      "TEST_APP",
      "LAUNCH_REVIEW",
      "WEEKLY_MONITOR",
      "FULL_PENTEST",
      "COMPLIANCE_REVIEW",
    ]),
    mode: z.enum(["SAFE", "QUICK", "STANDARD", "DEEP", "CUSTOM"]),
    workflow: z.enum(["REVIEW_TARGET", "REVIEW_CHANGES", "AUTHENTICATED_ASSESSMENT"]).optional(),
    baseRef: z.string().min(1).max(255).optional(),
    headRef: z.string().min(1).max(255).optional(),
    attachmentIds: z.array(z.string().min(1).max(128)).max(20).optional(),
    authorizationRef: z.string().min(1).max(256).optional(),
  })
  .superRefine((data, ctx) => {
    if ((data.baseRef || data.headRef) && data.workflow !== "REVIEW_CHANGES") {
      ctx.addIssue({ code: "custom", path: ["workflow"], message: "Refs require REVIEW_CHANGES" })
    }
    if (data.workflow === "REVIEW_CHANGES" && !data.baseRef) {
      ctx.addIssue({ code: "custom", path: ["baseRef"], message: "baseRef is required" })
    }
    if (data.authorizationRef && data.workflow !== "AUTHENTICATED_ASSESSMENT") {
      ctx.addIssue({ code: "custom", path: ["authorizationRef"], message: "Invalid workflow" })
    }
    if (data.workflow === "AUTHENTICATED_ASSESSMENT" && !data.authorizationRef) {
      ctx.addIssue({
        code: "custom",
        path: ["authorizationRef"],
        message: "Authorization required",
      })
    }
  })

/** Advisory GET only. A successful response never reserves a worker or minutes. */
export function getScanEligibility(
  client: LyraShieldClient,
  input: ScanEligibilityInput,
  options?: { signal?: AbortSignal }
): Promise<z.infer<typeof ScanEligibilitySchema>> {
  const data = ScanEligibilityInputSchema.parse(input)
  const params = new URLSearchParams({
    workspaceId: data.workspaceId ?? client.workspaceId ?? "",
    targetId: data.targetId,
    goal: data.goal,
    mode: data.mode,
  })
  if (data.workflow) params.set("workflow", data.workflow)
  if (data.baseRef) params.set("baseRef", data.baseRef)
  if (data.headRef) params.set("headRef", data.headRef)
  if (data.authorizationRef) params.set("authorizationRef", data.authorizationRef)
  for (const id of data.attachmentIds ?? []) params.append("attachmentId", id)
  return client.request("GET", `/scans/eligibility?${params.toString()}`, {
    signal: options?.signal,
    parse: (response) => ScanEligibilitySchema.parse(response),
  })
}
