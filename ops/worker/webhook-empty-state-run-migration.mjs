#!/usr/bin/env node
import {
  readPolicy,
  readAuthorization,
  atomicRootWrite,
  runDirectory,
} from "../../packages/db/scripts/webhook-empty-state-root-store.mjs"
import {
  requireValue,
  validateAuthorization,
} from "../../packages/db/scripts/webhook-empty-state-receipt-v2.mjs"
import { runEmptyStateMigration } from "../../packages/db/scripts/webhook-empty-state-migration.mjs"
const ENABLED = false
try {
  requireValue(ENABLED, "Production empty-state runner adapter remains disabled")
  const policy = readPolicy(),
    authorization = readAuthorization(policy)
  validateAuthorization(authorization, policy)
  // The approved host environment supplies a validated direct/session URL.
  // Both driver aliases are exactly equal before any Prisma child is spawned.
  requireValue(
    process.env.DATABASE_DIRECT_URL && process.env.DATABASE_DIRECT_URL === process.env.DATABASE_URL,
    "Migration URL aliases must be identical"
  )
  const result = await runEmptyStateMigration({
    env: {
      ...process.env,
      WEBHOOK_EMPTY_STATE_CUTOVER: "true",
      DEPLOY_SHA: authorization.sourceSha,
      GITHUB_RUN_ID: authorization.runId,
      WEBHOOK_EMPTY_STATE_STABLE_NONCE: authorization.nonce,
      WEBHOOK_EMPTY_STATE_DATABASE_IDENTITY_SHA256: policy.databaseIdentitySha256,
    },
  })
  atomicRootWrite(`${runDirectory(policy.runId)}/migration-result.json`, result)
} catch {
  process.stderr.write("Fixed migration adapter failed; retain maintenance\n")
  process.exitCode = 1
}
