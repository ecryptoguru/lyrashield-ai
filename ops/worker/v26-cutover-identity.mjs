import { createHash } from "node:crypto"
const hash = (value) =>
  createHash("sha256")
    .update(value ?? "")
    .digest("hex")
const fail = () => {
  throw new Error("v26 worker cutover identity mismatch")
}

export function assertV26WorkerIdentity({
  receipt,
  request,
  image,
  environment,
  protocol,
  allowComplete = false,
}) {
  if (
    protocol !== "reservations/2" ||
    !receipt ||
    receipt.kind !== "v26-accounting-cutover" ||
    receipt.version !== 1 ||
    receipt.recoveryPolicy !== "REPAIR_FORWARD_ONLY"
  )
    fail()
  const fixed = receipt.identity
  const stop = JSON.parse(receipt.stop)
  if (
    !fixed ||
    !/^[a-f0-9]{40}$/.test(fixed.sourceRevision ?? "") ||
    !/^[a-f0-9]{40}$/.test(fixed.engineRevision ?? "") ||
    !/^sha256:[a-f0-9]{64}$/.test(fixed.workerDigest ?? "") ||
    !/^sha256:[a-f0-9]{64}$/.test(fixed.webDigest ?? "") ||
    !/^[1-9][0-9]{0,19}$/.test(fixed.runId ?? "") ||
    !Number.isSafeInteger(fixed.attempt) ||
    fixed.attempt < 1 ||
    fixed.owner !== `${fixed.runId}:${fixed.attempt}` ||
    stop.reason !== "v26-accounting-cutover" ||
    stop.operator !== "github-actions" ||
    stop.owner !== fixed.owner ||
    stop.runId !== fixed.runId ||
    stop.productRevision !== fixed.sourceRevision
  )
    fail()
  if (receipt.phase === "COMPLETE" && allowComplete) return receipt.stop
  if (
    !["MIGRATED", "VERIFIED", "RELEASE_INTENT", "RELEASED"].includes(receipt.phase) ||
    environment.LYRASHIELD_PRODUCT_REVISION !== fixed.sourceRevision ||
    environment.LYRASHIELD_ENGINE_REVISION !== fixed.engineRevision ||
    environment.LYRASHIELD_WORKER_IMAGE_DIGEST !== fixed.workerDigest ||
    !image.endsWith(`@${fixed.workerDigest}`) ||
    ["databaseUrlSha256", "databaseSystemUrlSha256", "redisUrlSha256"].some(
      (key, index) =>
        receipt.baseline?.worker?.[key] !==
        hash(environment[["DATABASE_URL", "DATABASE_SYSTEM_URL", "REDIS_URL"][index]])
    )
  )
    fail()
  if (request) {
    for (const key of [
      "sourceRevision",
      "engineRevision",
      "workerDigest",
      "webDigest",
      "databaseIdentity",
      "redisIdentity",
    ])
      if (request[key] !== fixed[key]) fail()
    if (request.runId !== fixed.runId || request.attempt < (receipt.lastAttempt ?? fixed.attempt))
      fail()
  }
  return receipt.stop
}
