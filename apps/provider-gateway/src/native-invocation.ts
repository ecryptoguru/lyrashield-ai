import { z } from "zod"
import {
  authorityActionSchema,
  canonicalJson,
  sha256Hex,
  type JournalRecord,
} from "@lyrashield/runtime-control"
import { ProviderGatewayError } from "./errors"
import type { ProviderJournalEvent } from "./journal-events"
import type { ProviderJournalState } from "./journal-state"

const id = z.string().min(3).max(192)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const providerInvocationSchema = z
  .object({
    guardId: id,
    grantId: id,
    providerId: id,
    binding: authorityActionSchema.refine((value) => value.phase === "PROVIDER_DISPATCH"),
  })
  .strict()
export const providerTransportAckSchema = z
  .object({
    requestId: id,
    grantId: id,
    attemptId: id,
    guardId: id,
    bindingHash: hash,
    statusCode: z.number().int().min(100).max(599),
    headersHash: hash,
    receivedAt: z.string().datetime({ offset: true }),
  })
  .strict()
export type ProviderInvocation = z.infer<typeof providerInvocationSchema>
export type ProviderTransportAck = z.infer<typeof providerTransportAckSchema>
export type ProviderNativeEvent = Extract<
  ProviderJournalEvent,
  { type: "request_invocation_bound" | "request_transport_ack" }
>

export function applyProviderNativeEvent(
  state: ProviderJournalState,
  record: JournalRecord<ProviderNativeEvent>
) {
  const event = record.payload
  const requestId =
    event.type === "request_invocation_bound"
      ? event.invocation.binding.requestId
      : event.ack.requestId
  const request = state.requests.get(requestId ?? "")
  const grant = request && state.grants.get(request.grantId)
  if (!request || !grant || !["PENDING", "UNKNOWN"].includes(request.outcome))
    throw new ProviderGatewayError(
      "JOURNAL_INTEGRITY",
      "Native provider request binding is unavailable",
      500
    )
  if (event.type === "request_invocation_bound") {
    const invocation = event.invocation
    const binding = invocation.binding
    const scope = grant.request
    const action = Object.fromEntries(
      [
        "requestId",
        "providerId",
        "path",
        "query",
        "method",
        "contentType",
        "accept",
        "bodyHash",
      ].map((key) => [key, request[key as keyof typeof request]])
    )
    if (
      request.invocation ||
      invocation.grantId !== request.grantId ||
      invocation.providerId !== request.providerId ||
      !grant.policy ||
      binding.operationId !== scope.operationId ||
      binding.attemptId !== scope.attemptId ||
      binding.scanId !== scope.scanId ||
      binding.workspaceId !== scope.workspaceId ||
      binding.authorityEpochId !== scope.authorityEpochId ||
      binding.authorityRevision !== scope.authorityRevision ||
      binding.authorityChecksum !==
        sha256Hex(canonicalJson({ request: scope, policy: grant.policy })) ||
      binding.actionChecksum !== sha256Hex(canonicalJson(action))
    )
      throw new ProviderGatewayError(
        "JOURNAL_INTEGRITY",
        "Native provider invocation does not match its original request",
        500
      )
    request.invocation = invocation
    request.invocationReceipt = record
    return
  }
  const ack = event.ack
  if (
    !request.invocation ||
    request.transportAck ||
    ack.grantId !== request.grantId ||
    ack.attemptId !== request.attemptId ||
    ack.guardId !== request.invocation.guardId ||
    ack.bindingHash !== sha256Hex(canonicalJson(request.invocation.binding))
  )
    throw new ProviderGatewayError(
      "JOURNAL_INTEGRITY",
      "Provider transport acknowledgement does not match its original invocation",
      500
    )
  request.transportAck = ack
  request.transportAckReceipt = record
}
