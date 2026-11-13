import { performance } from "node:perf_hooks"
import { canonicalJson, sha256Hex } from "@lyrashield/runtime-control"
import { ProviderGatewayError } from "./errors"
import { abortable } from "./proxy-utils"
import type { GrantState } from "./journal-events"
import type { ProviderNativeEvent } from "./native-invocation"
import type { ProviderGatewayServiceOptions, ProxyInput, ReadyProxyRequest } from "./proxy-request"

export class NonDispatchReceiptError extends Error {
  constructor(cause: unknown) {
    super("Non-dispatch receipt acknowledgement is unavailable", { cause })
  }
}

interface ProviderDispatchContext {
  options: ProviderGatewayServiceOptions
  serialized<T>(work: () => Promise<T>): Promise<T>
  assertGrantActive(grant: GrantState): void
  recordUnknown(requestId: string): Promise<unknown>
  recordNotDispatched(requestId: string): Promise<unknown>
  recordNative(event: ProviderNativeEvent): Promise<void>
}

export async function dispatchProviderRequest(
  context: ProviderDispatchContext,
  input: ProxyInput,
  prepared: ReadyProxyRequest,
  signal: AbortSignal,
  deadlineAt: number
): Promise<Response> {
  const { target, headers, grant } = prepared
  let mayInvoke = true
  let invoked = false
  let intentUncertain = false
  try {
    if (!context.options.authorityFence || !context.options.publishActionIntent)
      throw new ProviderGatewayError(
        "AUTHORITY_UNAVAILABLE",
        "Native scan authority is unavailable",
        503
      )
    const authorityInput = { request: grant.request, policy: grant.policy }
    const actionInput = {
      requestId: input.requestId,
      providerId: input.providerId,
      path: target.pathname,
      query: target.search,
      method: input.method,
      contentType: headers["content-type"] ?? null,
      accept: headers["accept"] ?? null,
      bodyHash: sha256Hex(input.body.toString("base64")),
    }
    const binding = {
      phase: "PROVIDER_DISPATCH" as const,
      operationId: grant.request.operationId,
      attemptId: grant.request.attemptId,
      scanId: grant.request.scanId,
      workspaceId: grant.request.workspaceId,
      authorityEpochId: grant.request.authorityEpochId,
      authorityRevision: grant.request.authorityRevision,
      authorityChecksum: sha256Hex(canonicalJson(authorityInput)),
      actionChecksum: sha256Hex(canonicalJson(actionInput)),
      requestId: input.requestId,
    }
    intentUncertain = true
    const intent = await context.options.publishActionIntent({
      binding,
      authorityInput,
      actionInput,
    })
    if (intent.kind !== "committed" || intent.requestId !== input.requestId) {
      throw new ProviderGatewayError("AUTHORITY_UNAVAILABLE", "dispatch intent is uncertain", 503)
    }
    intentUncertain = false
    // The last grant check and fetch invocation share the serialization
    // boundary with revocation. Return the promise inside an object so
    // slow providers never hold the control-plane serialization lock.
    const dispatched = await context.options.authorityFence.run(
      binding,
      (assertActive, invocation) =>
        context.serialized(async () => {
          assertActive()
          if (!invocation?.guardId)
            throw new ProviderGatewayError(
              "AUTHORITY_UNAVAILABLE",
              "Durable provider invocation guard is unavailable",
              503
            )
          if (!mayInvoke || invoked)
            throw new ProviderGatewayError(
              "AUTHORITY_UNAVAILABLE",
              "dispatch is no longer active",
              503
            )
          context.assertGrantActive(grant)
          if (signal.aborted || performance.now() >= deadlineAt)
            throw new ProviderGatewayError(
              "PROVIDER_UNAVAILABLE",
              "provider dispatch was aborted",
              502
            )
          await context.recordNative({
            type: "request_invocation_bound",
            invocation: {
              guardId: invocation.guardId,
              grantId: grant.grantId,
              providerId: input.providerId,
              binding,
            },
          })
          assertActive()
          if (!mayInvoke || signal.aborted || performance.now() >= deadlineAt)
            throw new ProviderGatewayError(
              "AUTHORITY_UNAVAILABLE",
              "Provider dispatch is no longer active",
              503
            )
          invoked = true
          const upstream = (context.options.fetchImpl ?? fetch)(target, {
            method: input.method,
            headers,
            body: input.body.byteLength > 0 ? input.body : undefined,
            redirect: "error",
            signal,
          })
          const acknowledged = upstream.then(async (response) => {
            const headerBytes = canonicalJson([...response.headers])
            if (Buffer.byteLength(headerBytes) > 65_536)
              throw new ProviderGatewayError(
                "PROVIDER_UNAVAILABLE",
                "Provider response headers exceed the bound",
                502
              )
            await context.serialized(() =>
              context.recordNative({
                type: "request_transport_ack",
                ack: {
                  requestId: input.requestId,
                  grantId: grant.grantId,
                  attemptId: grant.request.attemptId,
                  guardId: invocation.guardId,
                  bindingHash: sha256Hex(canonicalJson(binding)),
                  statusCode: response.status,
                  headersHash: sha256Hex(headerBytes),
                  receivedAt: new Date().toISOString(),
                },
              })
            )
            return response
          })
          void acknowledged.catch(() => undefined)
          return { upstream: acknowledged }
        })
    )
    mayInvoke = false
    return await abortable(dispatched.upstream, signal)
  } catch (error) {
    mayInvoke = false
    if (invoked || intentUncertain) await context.recordUnknown(input.requestId)
    else {
      try {
        await context.recordNotDispatched(input.requestId)
      } catch (cause) {
        throw new NonDispatchReceiptError(cause)
      }
    }
    if (error instanceof ProviderGatewayError) throw error
    throw new ProviderGatewayError("PROVIDER_UNAVAILABLE", "provider outcome is unknown", 502)
  }
}
