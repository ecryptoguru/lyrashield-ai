// Private APIs for the two protected operations. Store readers return verified,
// canonical UTF-8 JSON bytes by content hash, never API request objects/getters.
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import {
  pairedReleaseReceipt,
  SCAN_ADMISSION_KEY,
} from "../../ops/monitoring/paired-release-hold.mjs"

export function requireProof(condition) {
  if (!condition) throw new Error("Protected paired runtime proof mismatch")
}
export const hashRecord = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")
function hash(value) {
  requireProof(typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
  return value
}
async function record(adapter, kind, id, fields) {
  hash(id)
  let raw
  try {
    raw = await adapter.readProtectedRecord(kind, id)
  } catch {
    throw new Error("Protected release record unavailable")
  }
  requireProof(
    typeof raw === "string" &&
      Buffer.byteLength(raw, "utf8") <= 4096 &&
      createHash("sha256").update(raw).digest("hex") === id
  )
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("Invalid protected record")
  }
  requireProof(
    parsed?.kind === kind &&
      JSON.stringify(parsed) === raw &&
      isDeepStrictEqual(Object.keys(parsed).sort(), ["kind", ...fields].sort())
  )
  return parsed
}
const forbiddenEngine = "3001517530300ca5f602536bfadcbd3c95ad3039"
const forbiddenProducer = "b03f0bbe2b42f3a49e24e103655187372ba0a5f6"
async function archive(adapter, id, identity) {
  const a = await record(adapter, "qualified-fleet", id, [
    "pair",
    "releaseProof",
    "sandboxProof",
    "financialProof",
    "readerProof",
    "connectionProof",
  ])
  for (const key of [
    "releaseProof",
    "sandboxProof",
    "financialProof",
    "readerProof",
    "connectionProof",
  ])
    hash(a[key])
  let p
  try {
    p = identity(a.pair)
  } catch {
    throw new Error("Invalid archived runtime identity")
  }
  requireProof(
    isDeepStrictEqual(p, a.pair) &&
      p.engineRevision !== forbiddenEngine &&
      p.productRevision !== forbiddenProducer
  )
  requireProof((await adapter.verifyQualifiedArchive(id)) === true)
  return { ...a, pair: p }
}
function owner(value) {
  requireProof(typeof value === "string" && /^[1-9][0-9]{0,19}:[1-9][0-9]{0,9}$/.test(value))
  return value
}
async function acquisition(adapter, id, identity) {
  const acq = await record(adapter, "hold-acquisition", id, [
    "owner",
    "fleet",
    "continuity",
    "selectorHash",
  ])
  owner(acq.owner)
  hash(acq.continuity)
  if (acq.selectorHash !== null) hash(acq.selectorHash)
  const fleet = await archive(adapter, acq.fleet, identity)
  return { acq, fleet, source: identity({ ...fleet.pair, owner: acq.owner }) }
}

export async function recoveryAuthority(adapter, id, identity) {
  const r = await record(adapter, "restore", id, [
    "nonce",
    "owner",
    "sourceAcquisition",
    "destinationArchive",
    "reversePlan",
    "handoff",
    "baselineEvidence",
    "canaryEvidence",
  ])
  for (const k of [
    "nonce",
    "sourceAcquisition",
    "destinationArchive",
    "reversePlan",
    "baselineEvidence",
    "canaryEvidence",
  ])
    hash(r[k])
  requireProof(
    r.baselineEvidence !== r.canaryEvidence &&
      owner(r.owner) === (await adapter.readAuthenticatedOwner())
  )
  const { acq, fleet, source } = await acquisition(adapter, r.sourceAcquisition, identity)
  const handoff = await record(adapter, "handoff", r.handoff, [
    "authorization",
    "sourceOwner",
    "newOwner",
    "sourceAcquisition",
    "destinationArchive",
    "reversePlan",
    "nonceHash",
  ])
  requireProof(
    ["original-owner", "approved-takeover"].includes(handoff.authorization) &&
      handoff.sourceOwner === source.owner &&
      handoff.newOwner === r.owner &&
      r.owner.split(":")[0] !== source.owner.split(":")[0] &&
      handoff.sourceAcquisition === r.sourceAcquisition &&
      handoff.destinationArchive === r.destinationArchive &&
      handoff.reversePlan === r.reversePlan &&
      handoff.nonceHash === hashRecord(r.nonce)
  )
  requireProof((await adapter.verifyRecoveryHandoff(r.handoff, source.owner, r.owner)) === true)
  const dest = await archive(adapter, r.destinationArchive, identity)
  requireProof(
    source.engineRevision === dest.pair.engineRevision &&
      source.productRevision !== dest.pair.productRevision &&
      source.workerDigest !== dest.pair.workerDigest &&
      source.priorWorkerDigest === dest.pair.workerDigest &&
      fleet.connectionProof === dest.connectionProof
  )
  const reverse = { ...dest.pair, owner: r.owner, priorWorkerDigest: source.workerDigest }
  for (const name of ["relay", "app", "scanner"]) {
    requireProof(source[name].previous === dest.pair[name].candidate)
    reverse[name] = { previous: source[name].candidate, candidate: dest.pair[name].candidate }
  }
  const pair = identity(reverse)
  requireProof(hashRecord(pair) === r.reversePlan)
  return { source, pair, acq, r, archive: dest, sourceArchive: fleet }
}

export async function armedAuthority(adapter, id, identity) {
  const r = await record(adapter, "arm", id, [
    "nonce",
    "owner",
    "sourceAcquisition",
    "selectorHash",
    "inputHash",
    "issuedAtMs",
    "expiresAtMs",
    "capUsd",
  ])
  for (const k of ["nonce", "selectorHash", "inputHash"]) hash(r[k])
  requireProof(owner(r.owner) === (await adapter.readAuthenticatedOwner()))
  requireProof((await adapter.verifyArmAuthorization(id, r.owner)) === true)
  const { acq, fleet, source: pair } = await acquisition(adapter, r.sourceAcquisition, identity)
  requireProof(
    acq.owner === r.owner &&
      acq.owner !== fleet.pair.owner &&
      acq.selectorHash === null &&
      r.capUsd > 0 &&
      typeof r.capUsd === "number" &&
      r.capUsd <= 1
  )
  validateLease(r)
  return { r, pair, acq, fleet }
}

function validateLease(r) {
  requireProof(
    Number.isSafeInteger(r.issuedAtMs) &&
      Number.isSafeInteger(r.expiresAtMs) &&
      r.issuedAtMs > 0 &&
      r.expiresAtMs - r.issuedAtMs <= 900000 &&
      r.expiresAtMs - r.issuedAtMs >= 30000
  )
}
const bytes = (p) =>
  pairedReleaseReceipt(p.owner, p.productRevision, p.engineRevision, p.workerDigest)
export const rebindLua = `if redis.call("GET",KEYS[1]) ~= ARGV[1] or redis.call("PTTL",KEYS[1]) ~= -1 then return 0 end
redis.call("SET",KEYS[1],ARGV[2],"XX")
return 1`
export const observeLua = `local v=redis.call("GET",KEYS[1]); if not v then return "absent" end
if redis.call("PTTL",KEYS[1]) ~= -1 then return "foreign" end
if v==ARGV[1] then return "source" end; if v==ARGV[2] then return "destination" end; return "foreign"`
export const armedReleaseLua = `if redis.call("GET",KEYS[1]) ~= ARGV[1] or redis.call("PTTL",KEYS[1]) ~= -1 then return 0 end
local t=redis.call("TIME"); local ms=t[1]*1000+math.floor(t[2]/1000)
if ms<tonumber(ARGV[2]) or ms+30000>=tonumber(ARGV[3]) then return 0 end
return redis.call("DEL",KEYS[1])`
export async function rebindReceipt(redis, oldPair, newPair) {
  requireProof(oldPair.owner !== newPair.owner && oldPair.engineRevision === newPair.engineRevision)
  requireProof(
    (await redis.eval(rebindLua, 1, SCAN_ADMISSION_KEY, bytes(oldPair), bytes(newPair))) === 1
  )
}
export function observeRebind(redis, oldPair, newPair) {
  return redis.eval(observeLua, 1, SCAN_ADMISSION_KEY, bytes(oldPair), bytes(newPair))
}
export async function releaseWithinLease(redis, pair, r) {
  validateLease(r)
  requireProof(
    (await redis.eval(
      armedReleaseLua,
      1,
      SCAN_ADMISSION_KEY,
      bytes(pair),
      r.issuedAtMs,
      r.expiresAtMs
    )) === 1
  )
}

// Execute inside the trusted worker verification boundary. The transport must
// obtain private bytes through already validated descriptors; never pass these
// as CLI arguments or return the decoded selector, request UUID or principal.
// This does not grant runtime permission; the worker's native schema and
// scan.create receipt checks still apply at launch.
export function readSelectorBinding(pair, preparedBytes, runningValue) {
  const prefix = "LYRASHIELD_EVIDENCE_WRITER_CANARY="
  requireProof(
    Buffer.isBuffer(preparedBytes) &&
      preparedBytes.length <= 2084 &&
      typeof runningValue === "string" &&
      /^[A-Za-z0-9_-]{1,2048}$/.test(runningValue)
  )
  const runningBytes = Buffer.from(prefix + runningValue + "\n")
  requireProof(preparedBytes.equals(runningBytes))
  const decoded = Buffer.from(runningValue, "base64url")
  requireProof(decoded.toString("base64url") === runningValue)
  let s
  try {
    s = JSON.parse(decoded.toString("utf8"))
  } catch {
    throw new Error("Invalid private selector")
  }
  requireProof(
    s &&
      typeof s === "object" &&
      JSON.stringify(s) === decoded.toString("utf8") &&
      s.version === 1 &&
      s.principalType === "BROWSER_SESSION" &&
      s.goal === "LAUNCH_REVIEW" &&
      s.mode === "QUICK" &&
      typeof s.requestId === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(s.requestId)
  )
  requireProof(
    s.productRevision === pair.productRevision &&
      s.engineRevision === pair.engineRevision &&
      s.workerImageDigest === pair.workerDigest &&
      s.sandboxImageDigest === pair.sandboxDigest
  )
  requireProof(
    isDeepStrictEqual(
      Object.keys(s).sort(),
      [
        "version",
        "workspaceId",
        "targetId",
        "principalType",
        "principalId",
        "requestId",
        "goal",
        "mode",
        "capUsd",
        "inputHash",
        "productRevision",
        "engineRevision",
        "workerImageDigest",
        "sandboxImageDigest",
        "issuedAtMs",
        "expiresAtMs",
      ].sort()
    )
  )
  for (const k of ["workspaceId", "targetId", "principalId"])
    requireProof(typeof s[k] === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(s[k]))
  validateLease(s)
  requireProof(typeof s.capUsd === "number" && s.capUsd > 0 && s.capUsd <= 1)
  const fileHash = createHash("sha256").update(preparedBytes).digest("hex")
  return {
    preparedFileHash: fileHash,
    runningFileHash: fileHash,
    inputHash: hash(s.inputHash),
    sandboxDigest: pair.sandboxDigest,
    capUsd: s.capUsd,
    issuedAtMs: s.issuedAtMs,
    expiresAtMs: s.expiresAtMs,
  }
}

// Private worker readers must return a plain projection. A getter must never
// run while comparing values or leak a payload through its exception.
export async function verifyPrivateProjection(read, expected) {
  let valid = false
  try {
    const value = await read(),
      fields = Object.getOwnPropertyDescriptors(value)
    valid =
      Reflect.ownKeys(fields).length === Object.keys(expected).length &&
      Object.entries(expected).every(([key, wanted]) => {
        const d = Object.getOwnPropertyDescriptor(fields, key)?.value
        return d && Object.hasOwn(d, "value") && d.value === wanted
      })
  } catch {
    /* Emit only the fixed verification diagnostic. */
  }
  requireProof(valid)
}
