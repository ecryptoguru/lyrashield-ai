#!/usr/bin/env node
import { lstatSync } from "node:fs"
import {
  readRootFile,
  readPolicy,
  FENCE,
  ROOT,
} from "../../packages/db/scripts/webhook-empty-state-root-store.mjs"
import {
  canonical,
  sha256,
  requireValue,
  validateAuthorization,
} from "../../packages/db/scripts/webhook-empty-state-receipt-v2.mjs"

import {
  readRefreshedWorkerFingerprint,
  validateConsumerFingerprint,
} from "./webhook-empty-state-consumer-identity.mjs"
export function fencePresent(path = FENCE) {
  try {
    const entry = lstatSync(path)
    requireValue(!entry.isSymbolicLink(), "Startup fence is a symlink")
    return true
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}
export function validateStartupProof(fence, proof, policy, image, now = Date.now()) {
  const authorizationSha256 = validateAuthorization(fence.authorization, policy, now)
  requireValue(
    fence.schemaVersion === "webhook-empty-state-fence/v2" && fence.state === "migration-complete",
    "Empty-state maintenance forbids worker startup before migration completion"
  )
  requireValue(
    proof?.schemaVersion === "webhook-empty-state-completion/v2" &&
      proof.authorizationSha256 === authorizationSha256 &&
      proof.sourceSha === policy.sourceSha &&
      proof.databaseIdentitySha256 === policy.databaseIdentitySha256 &&
      proof.state === "complete" &&
      proof.schemaSha256 &&
      proof.historySha256 &&
      proof.indexSha256 &&
      proof.receiptSha256 === fence.receiptSha256 &&
      sha256(canonical(proof)) === fence.completionSha256,
    "Missing bound schema/index/history completion proof"
  )
  requireValue(
    image === policy.images.candidate && proof.workerImageDigest === policy.candidate.imageDigest,
    "Startup image is not the completed compatible candidate"
  )
  return true
}
if (process.argv[1]?.endsWith("webhook-empty-state-startup-fence.mjs")) {
  try {
    if (fencePresent()) {
      const fence = readRootFile(FENCE),
        policy = readPolicy()
      validateConsumerFingerprint(readRefreshedWorkerFingerprint(), policy, "worker")
      validateStartupProof(
        fence,
        readRootFile(`${ROOT}/${policy.runId}/completion.json`),
        policy,
        process.env.LYRASHIELD_WORKER_IMAGE
      )
    }
  } catch {
    process.stderr.write("Empty-state startup fence denied startup\n")
    process.exitCode = 1
  }
}
