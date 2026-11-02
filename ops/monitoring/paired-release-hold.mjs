/** A persistent admission latch, bound to one protected paired release. */
export const SCAN_ADMISSION_KEY = "lyrashield:scan-admission:stopped"

export function pairedReleaseReceipt(owner, productRevision, engineRevision, workerDigest) {
  if (
    !/^[1-9][0-9]{0,19}:[1-9][0-9]{0,9}$/.test(owner ?? "") ||
    !/^[a-f0-9]{40}$/.test(productRevision ?? "") ||
    !/^[a-f0-9]{40}$/.test(engineRevision ?? "") ||
    !/^sha256:[a-f0-9]{64}$/.test(workerDigest ?? "")
  ) {
    throw new Error("Invalid paired release identity")
  }
  return JSON.stringify({
    version: 1,
    operator: "github-actions",
    reason: "paired-release",
    owner,
    productRevision,
    engineRevision,
    workerDigest,
  })
}

// No expiry: a failed or abandoned release must never reopen admission by time.
// Identity validation precedes EVAL; every operation compares canonical bytes.
export const OWNED_HOLD_LUA = `
local current = redis.call("GET", KEYS[1])
if ARGV[1] == "claim" and not current then
  redis.call("SET", KEYS[1], ARGV[2])
  return 1
end
if current ~= ARGV[2] or redis.call("PTTL", KEYS[1]) ~= -1 then return 0 end
if ARGV[1] == "release" then return redis.call("DEL", KEYS[1]) end
if ARGV[1] == "claim" or ARGV[1] == "assert" then return 1 end
return 0`

export async function ownedHold(redis, operation, ...identity) {
  if (!["claim", "assert", "release"].includes(operation)) {
    throw new Error("Invalid owned hold operation")
  }
  const receipt = pairedReleaseReceipt(...identity)
  if (Number(await redis.eval(OWNED_HOLD_LUA, 1, SCAN_ADMISSION_KEY, operation, receipt)) !== 1) {
    throw new Error("Owned paired release hold absent, changed or expiring")
  }
  return receipt
}

export function assertHeldReadiness(readyCode, readyBody, scansCode, scansBody) {
  const ready = JSON.parse(readyBody)
  const scans = JSON.parse(scansBody)
  if (
    readyCode !== "200" ||
    ready.status !== "ready" ||
    ready.checks?.database !== true ||
    ready.checks?.redis !== true ||
    scansCode !== "503" ||
    scans.status !== "not_ready" ||
    scans.checks?.worker !== false
  ) {
    throw new Error("Paired release requires healthy API and held scan readiness")
  }
}
