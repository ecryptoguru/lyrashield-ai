import { z } from "zod"
import { canonicalJson, sha256Hex } from "@lyrashield/runtime-control"
import { ProviderGatewayError } from "./errors"
import { agentRequestSchema } from "./agent-request"
import { parseStrictJson } from "./strict-json"

const rateSchema = z.number().int().nonnegative().max(1_000_000_000_000)
export const requestPolicySchema = z
  .object({
    version: z.literal(1),
    adapter: z.enum(["responses-text-v1", "responses-agent-v1"]),
    // Exact pathname and query, including a server-approved API version.
    endpoint: z.string().min(1).max(4_096).startsWith("/"),
    pricingRevision: z.string().min(1).max(192),
    models: z
      .record(
        z.string().min(1).max(128),
        z
          .object({
            inputMicrosPerMillion: rateSchema,
            cachedInputMicrosPerMillion: rateSchema,
            cacheWriteInputMicrosPerMillion: rateSchema,
            outputMicrosPerMillion: rateSchema,
          })
          .strict()
      )
      .refine((models) => Object.keys(models).length > 0 && Object.keys(models).length <= 16),
    maxRequestBytes: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024),
    maxResponseBytes: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024),
    maxInputTokens: z.number().int().min(1_024).max(272_000),
    maxOutputTokens: z.number().int().positive().max(65_536),
    maxRequests: z.number().int().positive().max(100_000),
    maxConcurrentRequests: z.number().int().positive().max(16),
    maxGrantReservedCostMicros: z.number().int().positive().max(1_000_000_000_000),
    deadlineMs: z.number().int().min(10).max(120_000),
    idleTimeoutMs: z.number().int().min(10).max(30_000),
  })
  .strict()
export type RequestPolicy = z.infer<typeof requestPolicySchema>

const requestBodySchema = z
  .object({
    model: z.string().min(1).max(128),
    input: z.string().min(1),
    max_output_tokens: z.number().int().positive(),
    stream: z.boolean().default(false),
    // Forbid tools, media, attachments, previous-response IDs, automatic
    // truncation and all other provider-controlled acquisition or spending.
  })
  .strict()

export function policyDigest(policy: RequestPolicy): string {
  return sha256Hex(canonicalJson(policy))
}

export function costMicros(
  policy: RequestPolicy,
  model: string,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  reserve = false
): number {
  const rate = policy.models[model]
  if (!rate) throw new ProviderGatewayError("MODEL_DENIED", "model is not server-approved")
  const inputRate = reserve
    ? Math.max(
        rate.inputMicrosPerMillion,
        rate.cachedInputMicrosPerMillion,
        rate.cacheWriteInputMicrosPerMillion
      )
    : rate.inputMicrosPerMillion
  const units =
    BigInt(inputTokens - cachedInputTokens) * BigInt(inputRate) +
    BigInt(cachedInputTokens) * BigInt(rate.cachedInputMicrosPerMillion) +
    BigInt(outputTokens) * BigInt(rate.outputMicrosPerMillion)
  const micros = (units + 999_999n) / 1_000_000n
  if (micros > BigInt(Number.MAX_SAFE_INTEGER))
    throw new ProviderGatewayError("INVALID_PRICING", "server price exceeds accounting bounds")
  return Number(micros)
}

export function authorizeRequest(
  policy: RequestPolicy,
  input: { path: string; method: string; contentType: string; body: Buffer }
) {
  if (input.path !== policy.endpoint || input.method !== "POST")
    throw new ProviderGatewayError(
      "PROVIDER_PATH_DENIED",
      "provider endpoint is not server-approved"
    )
  if (input.contentType !== "application/json")
    throw new ProviderGatewayError("INVALID_CONTENT_TYPE", "provider request requires JSON", 400)
  if (input.body.byteLength > policy.maxRequestBytes)
    throw new ProviderGatewayError(
      "REQUEST_TOO_LARGE",
      "provider request exceeds the byte cap",
      413
    )
  let value: unknown
  try {
    value = parseStrictJson(input.body)
  } catch {
    throw new ProviderGatewayError("INVALID_PROVIDER_REQUEST", "provider request is invalid", 400)
  }
  const parsed = (
    policy.adapter === "responses-agent-v1" ? agentRequestSchema : requestBodySchema
  ).safeParse(value)
  if (!parsed.success)
    throw new ProviderGatewayError(
      "INVALID_PROVIDER_REQUEST",
      "provider request shape is not approved",
      400
    )
  const request = parsed.data
  if (!Object.hasOwn(policy.models, request.model))
    throw new ProviderGatewayError("MODEL_DENIED", "model is not server-approved")
  // Reserve the full server-approved input envelope. This intentionally
  // conservative text-only byte bound still needs tokenizer qualification;
  // it is not a token estimate or permission to open production admission.
  const inputBound =
    policy.adapter === "responses-agent-v1"
      ? input.body.byteLength +
        1_024 +
        128 * (Array.isArray(request.input) ? request.input.length : 1) +
        128 * ("tools" in request ? (request.tools?.length ?? 0) : 0)
      : Buffer.byteLength(request.input as string, "utf8") + 1_024
  if (inputBound > policy.maxInputTokens || request.max_output_tokens > policy.maxOutputTokens)
    throw new ProviderGatewayError(
      "TOKEN_CAP_EXCEEDED",
      "provider request exceeds token policy",
      400
    )
  return {
    model: request.model,
    maxOutputTokens: request.max_output_tokens,
    stream: request.stream,
    reservationMicros: costMicros(
      policy,
      request.model,
      policy.maxInputTokens,
      0,
      request.max_output_tokens,
      true
    ),
  }
}
