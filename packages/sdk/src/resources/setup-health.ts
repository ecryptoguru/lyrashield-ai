import { z } from "zod"
import type { LyraShieldClient } from "../client"

/**
 * Published SDK contract. `@lyrashield/types` owns the canonical schema but is
 * not a publishable dependency here, so this mirror must stay byte-for-byte
 * compatible in behavior; `setup-health.test.ts` compares both schemas and
 * fails on drift (including accepting unknown fields the server strips).
 */
const SetupHealthCheckSchema = z.object({
  code: z.string().min(1).max(96),
  status: z.enum(["ready", "blocked", "unknown"]),
  explanation: z.string().min(1).max(500),
  recoveryAction: z
    .enum([
      "SELECT_WORKSPACE",
      "RECONNECT_AGENT",
      "CONNECT_GITHUB",
      "VERIFY_DOMAIN",
      "ADD_API_SPEC",
      "REFRESH_ATTACHMENTS",
      "WAIT_FOR_PROVIDER",
      "WAIT_FOR_WORKER",
      "START_TRIAL",
      "REVIEW_BILLING",
      "EDIT_POLICY",
      "CONTACT_ADMIN",
      "RETRY_LATER",
    ])
    .nullable(),
})

export const SetupHealthSnapshotSchema = z.object({
  version: z.literal("lyrashield-setup-health/1.0.0"),
  status: z.enum(["ready", "blocked", "unknown"]),
  allowed: z.boolean(),
  checkedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  scopeFingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
  scope: z.object({
    workspaceId: z.string().min(1),
    targetId: z.string().min(1),
    goal: z.string().min(1),
    mode: z.string().min(1),
    workflow: z.string().min(1),
    policyFingerprint: z.string().nullable(),
    attachmentFingerprint: z.string().nullable(),
    authorizationFingerprint: z.string().nullable(),
    sourceRevision: z.string().nullable(),
  }),
  checks: z.array(SetupHealthCheckSchema),
  primaryCheck: z.string().min(1).max(96),
  limitations: z.array(z.string().max(500)),
})

export type SetupHealthSnapshot = z.infer<typeof SetupHealthSnapshotSchema>

export interface SetupHealthInput {
  workspaceId?: string
  targetId: string
  goal: string
  mode: string
  workflow?: "REVIEW_TARGET" | "REVIEW_CHANGES" | "AUTHENTICATED_ASSESSMENT"
  policyId?: string
  engineBudgetCeilingUsd?: number
  baseRef?: string
  headRef?: string
  attachmentIds?: string[]
  authorizationRef?: string
}

export function setupHealthQuery(
  client: LyraShieldClient,
  input: SetupHealthInput
): URLSearchParams {
  const params = new URLSearchParams()
  const workspaceId = input.workspaceId ?? client.workspaceId
  if (workspaceId) params.set("workspaceId", workspaceId)
  params.set("targetId", input.targetId)
  params.set("goal", input.goal)
  params.set("mode", input.mode)
  if (input.workflow) params.set("workflow", input.workflow)
  if (input.policyId) params.set("policyId", input.policyId)
  if (input.engineBudgetCeilingUsd !== undefined) {
    params.set("engineBudgetCeilingUsd", String(input.engineBudgetCeilingUsd))
  }
  if (input.baseRef) params.set("baseRef", input.baseRef)
  if (input.headRef) params.set("headRef", input.headRef)
  if (input.authorizationRef) params.set("authorizationRef", input.authorizationRef)
  for (const id of input.attachmentIds ?? []) params.append("attachmentIds", id)
  return params
}

export function getSetupHealth(
  client: LyraShieldClient,
  input: SetupHealthInput,
  options?: { signal?: AbortSignal }
): Promise<SetupHealthSnapshot> {
  return client.request("GET", `/setup-health?${setupHealthQuery(client, input).toString()}`, {
    signal: options?.signal,
    parse: (data) => SetupHealthSnapshotSchema.parse(data),
  })
}
