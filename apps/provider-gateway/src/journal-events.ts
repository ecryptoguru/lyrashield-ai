import { z } from "zod"
import { providerGrantRequestSchema, type ProviderGrantRequest } from "@lyrashield/runtime-control"
import { requestPolicySchema, type RequestPolicy } from "./request-policy"
import { terminalUsageSchema, type TerminalUsage } from "./provider-usage"
import { retainedResponseSchema, type RetainedResponse } from "./retained-response"

const issuedGrantSchema = z
  .object({
    grantRequestId: z.string(),
    grantId: z.string(),
    request: providerGrantRequestSchema,
    policy: requestPolicySchema.optional(),
  })
  .strict()
const revocationEventSchema = z
  .object({ grantId: z.string(), revokedAt: z.string(), reason: z.string(), attemptId: z.string() })
  .strict()
const requestStartedSchema = z
  .object({
    requestId: z.string(),
    grantId: z.string(),
    attemptId: z.string(),
    providerId: z.string(),
    // Canonical upstream identity: exact pathname, exact query string and the
    // normalized content negotiation headers actually forwarded upstream.
    path: z.string(),
    query: z.string(),
    method: z.string(),
    contentType: z.string().max(256),
    accept: z.string().max(1_024),
    bodyHash: z.string(),
    reservationMicros: z.number().int().nonnegative(),
    policyDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    model: z.string().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    stream: z.boolean().optional(),
  })
  .strict()
const requestResultSchema = z
  .object({
    requestId: z.string(),
    grantId: z.string(),
    attemptId: z.string(),
    outcome: z.enum(["SUCCEEDED", "FAILED", "UNKNOWN"]),
    statusCode: z.number().int().min(0).max(599).optional(),
    responseHash: z.string().optional(),
    responseBytes: z.number().int().nonnegative().optional(),
    usageId: z.string().optional(),
    usage: terminalUsageSchema.optional(),
    retainedResponse: retainedResponseSchema.optional(),
    detail: z.string().max(512).optional(),
  })
  .strict()

export const providerJournalEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("grant_issued"), grant: issuedGrantSchema }).strict(),
  z.object({ type: z.literal("grant_revoked"), revocation: revocationEventSchema }).strict(),
  z.object({ type: z.literal("request_started"), request: requestStartedSchema }).strict(),
  z.object({ type: z.literal("request_result"), result: requestResultSchema }).strict(),
  z
    .object({
      type: z.literal("legacy_request_uncertain"),
      requestId: z.string(),
      grantId: z.string(),
      attemptId: z.string(),
    })
    .strict(),
])
export type ProviderJournalEvent = z.infer<typeof providerJournalEventSchema>

export interface GrantState {
  request: ProviderGrantRequest
  grantId: string
  token: string
  revokedAt: string | null
  requestCount: number
  reservedCostMicros: number
  receiptHash: string
  policy?: RequestPolicy
}

export interface RequestState {
  requestId: string
  grantId: string
  attemptId: string
  providerId: string
  path: string
  query: string
  method: string
  contentType: string
  accept: string
  bodyHash: string
  reservationMicros: number
  policyDigest?: string
  model?: string
  maxOutputTokens?: number
  stream?: boolean
  outcome: "PENDING" | "SUCCEEDED" | "FAILED" | "UNKNOWN"
  statusCode?: number
  responseHash?: string
  responseBytes?: number
  usageId?: string
  usage?: TerminalUsage
  retainedResponse?: RetainedResponse
  detail?: string
  receiptHash: string
  receipt?: { sequence: number; hash: string; signature: string }
}
