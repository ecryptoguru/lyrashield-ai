import { createHash } from "node:crypto"
import { ProviderGatewayError } from "./errors"
import type { RequestState } from "./journal-events"
import { policyDigest, type RequestPolicy, authorizeRequest } from "./request-policy"
import { ResponsesUsageParser, type TerminalUsage } from "./provider-usage"
import { abortable, readBoundedResponse } from "./proxy-utils"

export async function readProviderResponse(
  upstream: Response,
  policy: RequestPolicy,
  approved: ReturnType<typeof authorizeRequest>,
  signal: AbortSignal,
  recordUnknown: () => Promise<unknown>
) {
  const parser = new ResponsesUsageParser(policy, {
    ...approved,
    policyDigest: policyDigest(policy),
  })
  const responseHasher = createHash("sha256")
  let responseBody: Buffer
  let usage: TerminalUsage | undefined
  try {
    responseBody = await abortable(
      readBoundedResponse(upstream, policy.maxResponseBytes, {
        signal,
        idleTimeoutMs: policy.idleTimeoutMs,
        onChunk: (chunk) => {
          responseHasher.update(chunk)
          if (upstream.ok) parser.push(chunk)
        },
      }),
      signal
    )
    if (upstream.ok) {
      const contentType = upstream.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
      if (contentType !== (approved.stream ? "text/event-stream" : "application/json"))
        throw new Error("provider response encoding mismatch")
      usage = parser.finish()
    } else throw new Error("provider returned no affirmative terminal usage")
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
