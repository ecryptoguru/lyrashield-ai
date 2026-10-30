import {
  openSync,
  readFileSync,
  lstatSync,
  renameSync,
  closeSync,
  fsyncSync,
  writeFileSync,
} from "node:fs"
import { dirname } from "node:path"
import { createV26CutoverReceipt, assertV26CutoverReceipt } from "./v26-cutover-receipt.mjs"

export const STOP_KEY = "lyrashield:scan-admission:stopped"
const phases = [
  "INTENT",
  "CLAIMED",
  "QUIESCED",
  "INVENTORIED",
  "MIGRATION_INTENT",
  "MIGRATED",
  "VERIFIED",
  "RELEASE_INTENT",
  "RELEASED",
  "COMPLETE",
]
const fail = () => {
  throw new Error("v26 durable ownership or phase mismatch")
}

export function readDurableReceipt(path, expectedUid = 0) {
  try {
    // These paths are source-controlled modules or private runner/VM receipt paths.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const stat = lstatSync(path)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== expectedUid ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 65536
    )
      fail()
    // These paths are source-controlled modules or private runner/VM receipt paths.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw new Error("v26 durable receipt unavailable")
  }
}

export function persistDurableReceipt(path, receipt) {
  const temporary = `${path}.${process.pid}.tmp`
  // These paths are source-controlled modules or private runner/VM receipt paths.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const fd = openSync(temporary, "wx", 0o600)
  try {
    // These paths are source-controlled modules or private runner/VM receipt paths.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(fd, JSON.stringify(receipt))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  // These paths are source-controlled modules or private runner/VM receipt paths.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  renameSync(temporary, path)
  // These paths are source-controlled modules or private runner/VM receipt paths.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const directory = openSync(dirname(path), "r")
  try {
    fsyncSync(directory)
  } finally {
    closeSync(directory)
  }
}

export function assertOperationalReceipt(receipt, request) {
  if (
    !receipt ||
    !phases.includes(receipt.phase) ||
    receipt.recoveryPolicy !== "REPAIR_FORWARD_ONLY"
  )
    fail()
  // The original receipt is immutable. Attempts may increase, never replace
  // the owner or silently adopt a different source/image/DB/Redis endpoint.
  const base = { ...receipt, phase: "CLAIMED" }
  delete base.recoveryPolicy
  assertV26CutoverReceipt(base, receipt.identity)
  for (const key of [
    "runId",
    "attempt",
    "owner",
    "sourceRevision",
    "engineRevision",
    "workerDigest",
    "webDigest",
    "databaseIdentity",
    "redisIdentity",
  ])
    if (request[key] !== receipt.identity[key]) fail()
  return receipt
}

const fileStore = (path) => ({
  read: () => readDurableReceipt(path),
  write: (receipt) => persistDurableReceipt(path, receipt),
})

export async function claimDurableStop({
  path,
  redis,
  request,
  baseline,
  store = fileStore(path),
}) {
  let receipt = store.read()
  if (!receipt) {
    if ((await redis.get(STOP_KEY)) !== null) fail()
    receipt = {
      ...createV26CutoverReceipt(request),
      recoveryPolicy: "REPAIR_FORWARD_ONLY",
      baseline,
    }
    // fsync intent before acquiring Redis. Retrying INTENT may repeat only NX.
    store.write(receipt)
  } else assertOperationalReceipt(receipt, request)
  if (["RELEASE_INTENT", "RELEASED", "COMPLETE"].includes(receipt.phase)) return receipt
  const current = await redis.get(STOP_KEY)
  if (current === null && receipt.phase !== "INTENT") fail()
  if (current !== null && current !== receipt.stop) fail()
  if (current === null) await redis.set(STOP_KEY, receipt.stop, "NX")
  if ((await redis.get(STOP_KEY)) !== receipt.stop) fail()
  receipt = {
    ...receipt,
    phase: receipt.phase === "INTENT" ? "CLAIMED" : receipt.phase,
  }
  store.write(receipt)
  return receipt
}

export async function requireOwnedStop({ path, redis, request, allowed, store = fileStore(path) }) {
  const receipt = assertOperationalReceipt(store.read(), request)
  if (allowed && !allowed.includes(receipt.phase)) fail()
  if ((await redis.get(STOP_KEY)) !== receipt.stop) fail()
  return receipt
}

export async function recordPhase(context, next, proof) {
  const receipt = await requireOwnedStop(context)
  const current = phases.indexOf(receipt.phase)
  const target = phases.indexOf(next)
  if (target !== current + 1 && target !== current) fail()
  const updated = { ...receipt, phase: next, proofs: { ...receipt.proofs, [next]: proof } }
  ;(context.store ?? fileStore(context.path)).write(updated)
  return updated
}

export async function releaseDurableStop(context, verifyCandidate) {
  const store = context.store ?? fileStore(context.path)
  let receipt = assertOperationalReceipt(store.read(), context.request)
  if (!["VERIFIED", "RELEASE_INTENT", "RELEASED", "COMPLETE"].includes(receipt.phase)) fail()
  await verifyCandidate(receipt)
  let current = await context.redis.get(STOP_KEY)
  if (current !== null && current !== receipt.stop) fail()
  if (current === null && receipt.phase === "VERIFIED") fail()
  if (receipt.phase === "VERIFIED") {
    receipt = { ...receipt, phase: "RELEASE_INTENT" }
    store.write(receipt)
  }
  if (current !== null) {
    // A lost reply is reconciled against the durable RELEASE_INTENT and live
    // candidate, never by claiming an absent stop or replaying scan work.
    try {
      await context.redis.eval(
        'if redis.call("GET",KEYS[1]) == ARGV[1] then return redis.call("DEL",KEYS[1]) else return 0 end',
        1,
        STOP_KEY,
        receipt.stop
      )
    } catch {
      /* readback below decides */
    }
    current = await context.redis.get(STOP_KEY)
    if (current !== null) fail()
  }
  receipt = { ...receipt, phase: "COMPLETE" }
  store.write(receipt)
  return receipt
}
