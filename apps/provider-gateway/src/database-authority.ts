import pg from "pg"
import { PostgresDurableScanAuthorityFence } from "@lyrashield/runtime-control"
import { createPgConnectionConfig } from "@lyrashield/db/src/connection-config"
import {
  createScanExecutionActionAuthorityVerifier,
  createScanExecutionActionIntentProducer,
} from "@lyrashield/db/src/scan-execution-action-intent"
import { createScanExecutionInvocationGuardWriter } from "@lyrashield/db/src/scan-execution-invocation-guard"
import type { SupervisorReceiptAuthority } from "@lyrashield/db/src/scan-supervisor-receipt-ingestion-verifier"
import type { ProviderRoute } from "./config"
import { requestPolicySchema } from "./request-policy"
import type { ProviderGatewayServiceOptions } from "./proxy-request"

/** Called only with the protected installation's connection, routes and source keys. */
export function createDatabaseProviderAuthority(options: {
  connectionString: string
  providers: ReadonlyMap<string, ProviderRoute>
  supervisorAuthority: SupervisorReceiptAuthority
}) {
  const approvedProviderPolicies = new Map(
    [...options.providers].map(([id, route]) => {
      if (id !== route.id) throw new Error("Provider route identity mismatch")
      return [id, requestPolicySchema.parse(route.requestPolicy)] as const
    })
  )
  if (approvedProviderPolicies.size === 0) throw new Error("No approved provider policies")
  const policy = {
    approvedProviderPolicies,
    supervisorAuthority: options.supervisorAuthority,
  }
  const producer = createScanExecutionActionIntentProducer({
    ...policy,
    connectionString: options.connectionString,
  })
  const pool = new pg.Pool({
    ...createPgConnectionConfig(options.connectionString),
    max: 2,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
  })
  const verify = createScanExecutionActionAuthorityVerifier(policy)
  const authority: Required<
    Pick<ProviderGatewayServiceOptions, "authorizeGrant" | "publishActionIntent" | "authorityFence">
  > = {
    authorizeGrant: async (request) =>
      requestPolicySchema.parse(await producer.authorizeGrant(request)),
    publishActionIntent: (input) => producer.publish(input),
    authorityFence: new PostgresDurableScanAuthorityFence(
      pool,
      verify,
      createScanExecutionInvocationGuardWriter(verify)
    ),
  }
  return {
    ...authority,
    async close() {
      await Promise.all([producer.close(), pool.end()])
    },
  }
}
