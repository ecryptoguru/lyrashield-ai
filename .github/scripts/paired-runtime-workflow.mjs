// Finite controller for protected paired releases. Production activation remains
// closed until a trusted broker/supervisor authority implementation exists.
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { protectedLiveAdapter } from "./paired-runtime-live.mjs"
import {
  readAuthenticatedOwner,
  readProtectedRecord,
  verifiedArtifact,
  verifyCurrentSource,
} from "./paired-runtime-github.mjs"
import {
  finishReboundPair,
  inspectReboundPair,
  promoteHeldPair,
  releaseArmedCanary,
  releaseRestoredPair,
  releaseVerifiedPair,
  restoreQualifiedPair,
  retryUnappliedRebind,
} from "./paired-runtime-release.mjs"

export const CONTROLLER_ACTIONS = Object.freeze([
  "preflight",
  "forward",
  "canary",
  "restore",
  "release",
])
const restorePhases = new Set(["begin", "inspect", "retry", "finish"])
const releaseStages = new Set(["forward", "restored"])
const sha40 = /^[a-f0-9]{40}$/
const sha64 = /^[a-f0-9]{64}$/
const digest = /^sha256:[a-f0-9]{64}$/
const owner = /^[1-9][0-9]{0,19}:[1-9][0-9]{0,9}$/
const revision = /^[a-z][a-z0-9-]{0,30}--[a-z0-9][a-z0-9-]{0,30}$/
const serviceNames = ["app", "scanner", "relay"]
const pairDigestFields = [
  "workerDigest",
  "webDigest",
  "proxyDigest",
  "priorWorkerDigest",
  "sandboxDigest",
]

export class PairedControllerBlocked extends Error {
  constructor(message) {
    super(message)
    this.name = "PairedControllerBlocked"
  }
}

function blocked(message) {
  throw new PairedControllerBlocked(message)
}

function plain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function same(actual, expected) {
  return typeof actual === "string" && actual === expected
}

function requiredDigest(value, message, pattern = digest) {
  if (typeof value !== "string" || !pattern.test(value)) blocked(message)
  return value
}

function requirePair(pair, source, currentOwner) {
  if (!plain(pair)) blocked("qualified release tuple missing")
  if (!same(pair.owner, currentOwner)) blocked("qualified release owner mismatch")
  if (!same(pair.productRevision, source) || !sha40.test(pair.productRevision))
    blocked("qualified release source mismatch")
  if (!sha40.test(pair.engineRevision)) blocked("qualified release engine invalid")
  for (const key of pairDigestFields) requiredDigest(pair[key], "qualified release digest invalid")
  const names = new Set()
  for (const name of serviceNames) {
    const value = pair[name]
    if (!plain(value) || !revision.test(value?.candidate) || !revision.test(value?.previous))
      blocked("qualified release revision invalid")
    if (value.candidate === value.previous) blocked("qualified release revision repeated")
    names.add(value.candidate.split("--")[0])
  }
  if (names.size !== serviceNames.length) blocked("qualified release services not distinct")
  return pair
}

function requireControlPlane(controlPlane) {
  if (!plain(controlPlane)) blocked("qualified release control-plane tuple missing")
  return {
    migrationChecksum: requiredDigest(
      controlPlane.migrationChecksum,
      "qualified release migration digest invalid"
    ),
    brokerDigest: requiredDigest(
      controlPlane.brokerDigest,
      "qualified release broker digest invalid"
    ),
    supervisorDigest: requiredDigest(
      controlPlane.supervisorDigest,
      "qualified release supervisor digest invalid"
    ),
    providerGatewayDigest: requiredDigest(
      controlPlane.providerGatewayDigest,
      "qualified release provider-gateway digest invalid"
    ),
  }
}

function requireRollback(rollback, pair, controlPlane) {
  if (!plain(rollback)) blocked("rollback tuple required")
  requiredDigest(rollback.archiveSha256, "rollback archive digest invalid", sha64)
  if (!sha40.test(rollback.productRevision)) blocked("rollback source invalid")
  if (!sha40.test(rollback.engineRevision)) blocked("rollback engine invalid")
  for (const key of ["workerDigest", "webDigest", "proxyDigest", "sandboxDigest"])
    requiredDigest(rollback[key], "rollback image digest invalid")
  for (const key of ["appRevision", "scannerRevision", "relayRevision"])
    if (!revision.test(rollback[key])) blocked("rollback revision invalid")
  for (const key of [
    "migrationChecksum",
    "brokerDigest",
    "supervisorDigest",
    "providerGatewayDigest",
  ])
    requiredDigest(rollback[key], "rollback control-plane digest invalid")

  if (rollback.engineRevision !== pair.engineRevision) blocked("rollback tuple mismatch")
  if (rollback.productRevision === pair.productRevision) blocked("rollback tuple mismatch")
  if (rollback.workerDigest === pair.workerDigest) blocked("rollback tuple mismatch")
  if (rollback.migrationChecksum !== controlPlane.migrationChecksum)
    blocked("rollback tuple mismatch")
  return rollback
}

function compareRollbackArchive(archive, rollback) {
  if (!plain(archive) || archive.kind !== "qualified-fleet" || !plain(archive.pair))
    blocked("rollback record unavailable")
  const pair = archive.pair
  const comparisons = [
    ["productRevision", pair.productRevision, rollback.productRevision],
    ["engineRevision", pair.engineRevision, rollback.engineRevision],
    ["workerDigest", pair.workerDigest, rollback.workerDigest],
    ["webDigest", pair.webDigest, rollback.webDigest],
    ["proxyDigest", pair.proxyDigest, rollback.proxyDigest],
    ["sandboxDigest", pair.sandboxDigest, rollback.sandboxDigest],
    ["appRevision", pair.app?.candidate, rollback.appRevision],
    ["scannerRevision", pair.scanner?.candidate, rollback.scannerRevision],
    ["relayRevision", pair.relay?.candidate, rollback.relayRevision],
  ]
  if (comparisons.some(([, actual, expected]) => !same(actual, expected)))
    blocked("rollback tuple mismatch")
  return pair
}

function parseRecord(raw) {
  let value
  try {
    value = JSON.parse(raw)
  } catch {}
  if (!plain(value)) blocked("qualified release record invalid")
  return value
}

function parseDigest(value, message = "qualified release digest must be a 64-character SHA-256") {
  if (typeof value !== "string" || !sha64.test(value)) blocked(message)
  return value
}

export function parseControllerInvocation(argv, environment = process.env) {
  if (!Array.isArray(argv) || argv.length !== 1) blocked("exactly one action is required")
  const [action] = argv
  if (!CONTROLLER_ACTIONS.includes(action)) blocked("unsupported action")
  const qualifiedReleaseSha256 = parseDigest(environment.PAIRED_QUALIFIED_RELEASE_SHA256)
  const invocation = { action, qualifiedReleaseSha256 }
  if (action === "canary") {
    invocation.armSha256 = parseDigest(
      environment.PAIRED_ARM_SHA256,
      "arm digest must be a 64-character SHA-256"
    )
  } else if (action === "restore") {
    invocation.restoreSha256 = parseDigest(
      environment.PAIRED_RESTORE_SHA256,
      "restore digest must be a 64-character SHA-256"
    )
    const phase = environment.PAIRED_RESTORE_PHASE || "begin"
    if (!restorePhases.has(phase)) blocked("unsupported restore phase")
    invocation.restorePhase = phase
  } else if (action === "release") {
    const stage = environment.PAIRED_RELEASE_STAGE
    if (!releaseStages.has(stage)) blocked("unsupported release stage")
    invocation.releaseStage = stage
    if (stage === "restored")
      invocation.restoreSha256 = parseDigest(
        environment.PAIRED_RESTORE_SHA256,
        "restore digest must be a 64-character SHA-256"
      )
  }
  return invocation
}

async function guarded(label, call) {
  try {
    return await call()
  } catch (error) {
    if (error instanceof PairedControllerBlocked) throw error
    blocked(label)
  }
}

async function verifyActionArtifact(invocation, source, currentOwner, dependencies) {
  const expected =
    invocation.action === "canary"
      ? ["arm", invocation.armSha256]
      : invocation.action === "restore" ||
          (invocation.action === "release" && invocation.releaseStage === "restored")
        ? ["restore", invocation.restoreSha256]
        : null
  if (!expected) return
  const artifact = await guarded("protected artifact unavailable", () =>
    dependencies.verifyArtifact(...expected)
  )
  if (!same(artifact?.owner, currentOwner) || !same(artifact?.source, source))
    blocked("protected artifact unavailable")
}

export async function preflightQualifiedRelease(
  qualifiedReleaseSha256,
  dependencies = {},
  invocation
) {
  parseDigest(qualifiedReleaseSha256)
  const readSource = dependencies.readSource ?? verifyCurrentSource
  const ownerWorkflow =
    dependencies.ownerWorkflow ??
    (dependencies.environment ?? process.env).PAIRED_JOB_WORKFLOW ??
    ".github/workflows/deploy-azure-runtime.yml"
  if (
    ![".github/workflows/deploy-azure-runtime.yml", ".github/workflows/deploy-azure.yml"].includes(
      ownerWorkflow
    )
  )
    blocked("owner workflow unavailable")
  if (
    invocation &&
    invocation.action !== "preflight" &&
    ownerWorkflow !== ".github/workflows/deploy-azure-runtime.yml"
  )
    blocked("owner workflow unavailable")
  const readOwner = dependencies.readOwner ?? (() => readAuthenticatedOwner(ownerWorkflow))
  const verifyArtifact = dependencies.verifyArtifact ?? verifiedArtifact
  const readRecord = dependencies.readProtectedRecord ?? readProtectedRecord
  const createAdapter = dependencies.createAdapter ?? protectedLiveAdapter
  const verifyAuthority = dependencies.verifyAuthority ?? verifyPairedAuthority

  const sourceRecord = await guarded("source verification failed", () => readSource())
  const source = sourceRecord?.source
  if (typeof source !== "string" || !sha40.test(source)) blocked("source verification failed")
  const currentOwner = await guarded("owner verification failed", () => readOwner())
  if (typeof currentOwner !== "string" || !owner.test(currentOwner))
    blocked("owner verification failed")
  if (invocation) await verifyActionArtifact(invocation, source, currentOwner, { verifyArtifact })

  const artifact = await guarded("protected artifact unavailable", () =>
    verifyArtifact("qualified-release", qualifiedReleaseSha256)
  )
  if (!same(artifact?.owner, currentOwner) || !same(artifact?.source, source))
    blocked("protected artifact unavailable")
  const release = parseRecord(artifact.raw)
  if (release.kind !== "qualified-release" || !same(release.owner, currentOwner))
    blocked("qualified release record invalid")
  const pair = requirePair(release.pair, source, currentOwner)
  const controlPlane = requireControlPlane(release.controlPlane)
  const rollback = requireRollback(release.rollback, pair, controlPlane)

  const adapter = await guarded("paired infrastructure adapter unavailable", () => createAdapter())
  const archiveRaw = await guarded("rollback record unavailable", () =>
    readRecord("qualified-fleet", rollback.archiveSha256)
  )
  const archivePair = compareRollbackArchive(parseRecord(archiveRaw), rollback)
  await guarded("rollback archive unavailable", () =>
    adapter.verifyQualifiedArchive(rollback.archiveSha256)
  )
  await guarded("rollback availability unverified", () =>
    adapter.verifyRollbackAvailability(archivePair)
  )

  const context = {
    source,
    owner: currentOwner,
    qualifiedReleaseSha256,
    pair: Object.freeze({ ...pair }),
    controlPlane: Object.freeze({ ...controlPlane }),
    rollback: Object.freeze({ ...rollback }),
    adapter,
  }
  await guarded("paired broker/supervisor authority unavailable", () => verifyAuthority(context))
  return Object.freeze(context)
}

export async function verifyPairedAuthority() {
  throw new PairedControllerBlocked("paired broker/supervisor authority unavailable")
}

function root(adapter) {
  return { store: adapter.stageStore, path: "" }
}

const defaultImplementations = Object.freeze({
  promoteHeldPair,
  releaseArmedCanary,
  restoreQualifiedPair,
  inspectReboundPair,
  retryUnappliedRebind,
  finishReboundPair,
  releaseVerifiedPair,
  releaseRestoredPair,
})

export function createControllerActions(implementations = defaultImplementations, adapter, signal) {
  for (const name of [
    "promoteHeldPair",
    "releaseArmedCanary",
    "restoreQualifiedPair",
    "inspectReboundPair",
    "retryUnappliedRebind",
    "finishReboundPair",
    "releaseVerifiedPair",
    "releaseRestoredPair",
  ])
    if (typeof implementations?.[name] !== "function")
      blocked("paired controller implementation unavailable")
  const actions = {
    forward: (context) =>
      implementations.promoteHeldPair(context.pair, root(adapter), adapter, signal),
    canary: (context, invocation) =>
      implementations.releaseArmedCanary(invocation.armSha256, root(adapter), adapter, signal),
    restore: (context, invocation) => {
      if (invocation.restorePhase === "begin")
        return implementations.restoreQualifiedPair(
          invocation.restoreSha256,
          root(adapter),
          adapter,
          signal
        )
      if (invocation.restorePhase === "inspect")
        return implementations.inspectReboundPair(invocation.restoreSha256, root(adapter), adapter)
      if (invocation.restorePhase === "retry")
        return implementations.retryUnappliedRebind(
          invocation.restoreSha256,
          root(adapter),
          adapter,
          signal
        )
      if (invocation.restorePhase === "finish")
        return implementations.finishReboundPair(
          invocation.restoreSha256,
          root(adapter),
          adapter,
          signal
        )
      blocked("unsupported restore phase")
    },
    release: (context, invocation) => {
      if (invocation.releaseStage === "forward")
        return implementations.releaseVerifiedPair(context.pair, root(adapter), adapter, signal)
      if (invocation.releaseStage === "restored")
        return implementations.releaseRestoredPair(
          invocation.restoreSha256,
          root(adapter),
          adapter,
          signal
        )
      blocked("unsupported release stage")
    },
  }
  return Object.freeze(actions)
}

export async function runController(argv, dependencies = {}) {
  const invocation = parseControllerInvocation(argv, dependencies.environment)
  const context = await preflightQualifiedRelease(
    invocation.qualifiedReleaseSha256,
    dependencies,
    invocation
  )
  if (invocation.action === "preflight") return invocation
  const adapter = context.adapter
  const signal = dependencies.signal
  const actions =
    dependencies.actions ?? createControllerActions(dependencies.implementations, adapter, signal)
  const implementation = actions[invocation.action]
  if (typeof implementation !== "function") blocked("unsupported controller action")
  await guarded("paired controller action failed", () => implementation(context, invocation))
  return invocation
}

export function controllerFailure(error) {
  if (error instanceof PairedControllerBlocked)
    return "Paired release controller blocked: " + error.message + "\n"
  return "Paired release controller blocked: protected operation unavailable\n"
}

export async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout
  const stderr = dependencies.stderr ?? process.stderr
  try {
    const result = await runController(argv, dependencies)
    stdout.write("Paired release controller: " + result.action + "\n")
    return 0
  } catch (error) {
    stderr.write(controllerFailure(error))
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCli()
}
