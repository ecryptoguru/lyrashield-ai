import { createHash } from "node:crypto"
import { ProviderGatewayError } from "./errors"
import type { RequestState } from "./journal-events"
import { policyDigest, type RequestPolicy, authorizeRequest } from "./request-policy"
import { ResponsesUsageParser, type TerminalUsage } from "./provider-usage"
import { abortable, MAX_DELIVERY_CHUNK_BYTES, readBoundedResponse } from "./proxy-utils"
import { retainResponse } from "./retained-response"
import { providerUsageId } from "./journal-state"

export async function deliverCommittedStream(
  body: Buffer,
  deliveredBytes: number,
  sink: { write: (chunk: Uint8Array) => Promise<void>; complete: () => Promise<void> },
  deliver: (effect: () => Promise<void>) => Promise<void>
): Promise<void> {
  for (let offset = deliveredBytes; offset < body.byteLength; offset += MAX_DELIVERY_CHUNK_BYTES) {
    const chunk = body.subarray(offset, offset + MAX_DELIVERY_CHUNK_BYTES)
    await deliver(() => sink.write(chunk))
  }
  await deliver(() => sink.complete())
}

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
  } = {}
) {
  const parser = new ResponsesUsageParser(policy, {
    ...approved,
    policyDigest: policyDigest(policy),
  })
  const responseHasher = createHash("sha256")
  let responseBody: Buffer
  let usage: TerminalUsage | undefined
  let deliveredBytes = 0
  let pendingCarriageReturn = false
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
          if (delivery.write && !parser.hasTerminal) {
            // A trailing CR might itself end an SSE frame; wait for its LF.
            if (pendingCarriageReturn) {
              await delivery.write(Buffer.from("\r"))
              deliveredBytes += 1
            }
            pendingCarriageReturn = chunk.at(-1) === 13
            const safeChunk = pendingCarriageReturn ? chunk.subarray(0, -1) : chunk
            if (safeChunk.byteLength) {
              await delivery.write(safeChunk)
              deliveredBytes += safeChunk.byteLength
            }
          }
        },
      }),
      signal
    )
    usage = parser.finish()
  } catch {
    await recordUnknown()
    throw new ProviderGatewayError(
      "PROVIDER_RESPONSE_UNKNOWN",
      "provider response or terminal usage is unknown",
      502
    )
  }
  return { responseBody, usage, responseHash: responseHasher.digest("hex"), deliveredBytes }
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
