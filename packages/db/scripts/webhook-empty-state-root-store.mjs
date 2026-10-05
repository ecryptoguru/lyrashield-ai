import { constants, openSync, fstatSync, lstatSync, readFileSync, closeSync, mkdirSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { randomBytes } from "node:crypto"
import { canonical, sha256, requireValue, validateAuthorization } from "./webhook-empty-state-receipt-v2.mjs"

export const ROOT = "/var/lib/lyrashield/webhook-empty-state"
export const POLICY = "/etc/lyrashield/webhook-empty-state-policy.json"
export const FENCE = "/var/lib/lyrashield/webhook-empty-state/fence.json"
export function checkParents(path) {
  for (let parent = dirname(resolve(path)); parent !== "/"; parent = dirname(parent)) {
    const stat = lstatSync(parent)
    requireValue(!stat.isSymbolicLink() && stat.isDirectory() && stat.uid === 0 && !(stat.mode & 0o022), "Unsafe root path ancestor")
  }
}
export function readRootFile(path) {
  checkParents(path)
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(descriptor)
    requireValue(stat.isFile() && stat.uid === 0 && (stat.mode & 0o777) === 0o600 && stat.nlink === 1 && stat.size <= 256_000, "Unsafe root file")
    const bytes = readFileSync(descriptor, "utf8"), value = JSON.parse(bytes)
    requireValue(canonical(value) === bytes, "Noncanonical root file")
    return value
  } finally { closeSync(descriptor) }
}
export function atomicRootWrite(path, value) {
  requireValue(process.getuid?.() === 0 && path.startsWith(ROOT + "/"), "Root-only fixed state directory")
  checkParents(path)
  try { const stat = lstatSync(path); requireValue(!stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o777) === 0o600 && stat.nlink === 1, "Unsafe prior state") } catch (error) { if (error.code !== "ENOENT") throw error }
  const temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, canonical(value)); fsyncSync(fd) } finally { closeSync(fd) }
  try { renameSync(temporary, path); const dir = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(dir) } finally { closeSync(dir) } } catch (error) { try { unlinkSync(temporary) } catch {} throw error }
}
export function readPolicy() {
  requireValue(process.getuid?.() === 0, "Trusted producer requires root")
  const policy = readRootFile(POLICY), unsigned = { ...policy }; delete unsigned.policySha256
  requireValue(sha256(canonical(unsigned)) === policy.policySha256, "Root policy digest mismatch")
  requireValue(policy.schemaVersion === "webhook-empty-state-policy/v2", "Wrong root policy version")
  return policy
}
export function runDirectory(runId) {
  requireValue(/^[1-9][0-9]{0,19}$/.test(runId || ""), "Invalid run ID")
  const directory = `${ROOT}/${runId}`
  // Installation of ROOT is separate owner-approved setup; never make ancestors.
  checkParents(directory)
  try { mkdirSync(directory, { mode: 0o700 }) } catch (error) { if (error.code !== "EEXIST") throw error }
  const stat = lstatSync(directory)
  requireValue(!stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o777) === 0o700, "Unsafe run directory")
  return directory
}
export function readAuthorization(policy, now = Date.now()) {
  const directory = runDirectory(policy.runId), path = `${directory}/authorization.json`
  let authorization
  try { authorization = readRootFile(path) } catch (error) {
    if (error.code !== "ENOENT") throw error
    authorization = Object.fromEntries(["sourceSha", "runId", "originalAttempt", "nonce", "issuedAt", "expiresAt", "policySha256", "producerSha256", "workflowSha", "repositoryId", "ownerId"].map(key => [key, policy[key]]))
    authorization.owner = `${policy.runId}:${policy.originalAttempt}`
    validateAuthorization(authorization, policy, now)
    atomicRootWrite(path, authorization)
  }
  validateAuthorization(authorization, policy, now)
  return authorization
}
