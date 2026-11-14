import type { ScanAuthorityFence } from "@lyrashield/runtime-control"
import type { RequestPolicy } from "./request-policy"
import type { ProviderGatewayServiceOptions } from "./proxy-request"
export const fixturePolicy: RequestPolicy = {
  version: 1,
  adapter: "responses-text-v1",
  endpoint: "/openai/responses?api-version=1",
  pricingRevision: "synthetic-v1",
  models: {
    "gpt-6-luna": {
      inputMicrosPerMillion: 100_000,
      cachedInputMicrosPerMillion: 10_000,
      cacheWriteInputMicrosPerMillion: 125_000,
      outputMicrosPerMillion: 500_000,
    },
  },
  maxRequestBytes: 16_384,
  maxResponseBytes: 65_536,
  maxInputTokens: 2_048,
  maxOutputTokens: 64,
  maxRequests: 10,
  maxConcurrentRequests: 2,
  maxGrantReservedCostMicros: 10_000,
  deadlineMs: 1_000,
  idleTimeoutMs: 100,
}

// Synthetic lifecycle fixtures do not establish database authorization.
export const fixtureAuthorityFence: ScanAuthorityFence = {
  run: async (binding, effect) =>
    effect(() => undefined, { guardId: `fixture-${binding.requestId ?? binding.operationId}` }),
}

// Synthetic producer acknowledgement; real database intent validation is separate.
export const fixtureActionIntentPublisher: NonNullable<
  ProviderGatewayServiceOptions["publishActionIntent"]
> = async ({ binding }) => ({
  kind: "committed",
  requestId: binding.requestId!,
  actionId: `fixture-${binding.requestId}`,
})
