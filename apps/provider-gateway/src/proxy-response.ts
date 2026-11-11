import { createHash } from "node:crypto"
import { ProviderGatewayError } from "./errors"
import type { RequestState } from "./journal-events"
import { policyDigest, type RequestPolicy, authorizeRequest } from "./request-policy"
import { ResponsesUsageParser, type TerminalUsage } from "./provider-usage"
import { abortable, readBoundedResponse } from "./proxy-utils"
import { retainResponse } from "./retained-response"
import { providerUsageId } from "./journal-state"

// Pure payload preparation; the service fences authority and durably records it.
export function prepareRetainedResponse(
  encryptionSecret: string,
  signingSecret: string,
  state: RequestState,
  response: { statusCode: number; headers: Record<string, string>; body: Buffer },
  responseHash: string,
  usage: TerminalUsage | undefined,
  streamed: boolean
) {
  if (usage && !streamed)
    response.headers["x-lyra-usage-id"] = providerUsageId(signingSecret, state, usage)
  return retainResponse(
    encryptionSecret,
    responseBinding({
      ...state,
      statusCode: response.statusCode,
      responseHash,
      responseBytes: response.body.byteLength,
      usage,
    }),
    response
  )
}

export async function readProviderResponse(
  upstream: Response,
  policy: RequestPolicy,
  approved: ReturnType<typeof authorizeRequest>,
  signal: AbortSignal,
  recordUnknown: () => Promise<unknown>,
  delivery: {
    deadlineAt?: number
    start?: () => Promise<void>
    write?: (chunk: Uint8Array) => Promise<void>
    complete?: () => Promise<void>
  } = {}
) {
  const parser = new ResponsesUsageParser(policy, {
    ...approved,
    policyDigest: policyDigest(policy),
  })
  const responseHasher = createHash("sha256")
  let responseBody: Buffer
  let usage: TerminalUsage | undefined
  try {
    if (
      !upstream.ok ||
      upstream.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        (approved.stream ? "text/event-stream" : "application/json")
    )
      throw new Error("provider response encoding or outcome is unavailable")
    await delivery.start?.()
    responseBody = await abortable(
      readBoundedResponse(upstream, policy.maxResponseBytes, {
        signal,
        deadlineAt: delivery.deadlineAt,
        idleTimeoutMs: policy.idleTimeoutMs,
        onChunk: async (chunk) => {
          responseHasher.update(chunk)
          parser.push(chunk)
          await delivery.write?.(chunk)
        },
      }),
      signal
    )
    usage = parser.finish()
    await delivery.complete?.()
  } catch {
    await recordUnknown()
    throw new ProviderGatewayError(
      "PROVIDER_RESPONSE_UNKNOWN",
      "provider response or terminal usage is unknown",
      502
    )
  }
  return { responseBody, usage, responseHash: responseHasher.digest("hex") }
}

export function responseBinding(state: RequestState) {
  return {
    version: 1,
    requestId: state.requestId,
    grantId: state.grantId,
    attemptId: state.attemptId,
    providerId: state.providerId,
    path: state.path,
    query: state.query,
    method: state.method,
    contentType: state.contentType,
    accept: state.accept,
    bodyHash: state.bodyHash,
    policyDigest: state.policyDigest ?? null,
    statusCode: state.statusCode ?? null,
    responseHash: state.responseHash ?? null,
    responseBytes: state.responseBytes ?? null,
    usage: state.usage ?? null,
  }
}
