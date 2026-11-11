// Unwired composition for protected GitHub Actions. No injected proof booleans,
// generic command dispatcher, live scan, or deployment entry point.
import { createHash } from "node:crypto"
import { pairedReleaseReceipt } from "../../ops/monitoring/paired-release-hold.mjs"
import * as cloud from "./paired-runtime-cloud.mjs"
import { vmStageStore } from "./paired-stage-store.mjs"
import { guest, liveRedis } from "./paired-live-transport.mjs"
import { readHeldBaselineArchive } from "./paired-runtime-qualification.mjs"
import {
  readAuthenticatedOwner,
  readProtectedRecord,
  verifiedArtifact,
  verifyCurrentSource,
  verifyEngineRun,
  verifySandboxAttestation,
  verifyEnvironmentApproval,
  protectedSessionCookie,
} from "./paired-runtime-github.mjs"

function ok(c) {
  if (!c) throw new Error("Protected live evidence unavailable")
}
const sha = (x) => createHash("sha256").update(x).digest("hex")
const s256 = /^[a-f0-9]{64}$/
function receipt(p) {
  return pairedReleaseReceipt(p.owner, p.productRevision, p.engineRevision, p.workerDigest)
}
function protectedId(k) {
  const v = process.env[k]
  ok(typeof v === "string" && s256.test(v))
  return v
}
function record(a) {
  let v
  try {
    v = JSON.parse(a.raw)
  } catch {}
  ok(v && Object.getPrototypeOf(v) === Object.prototype)
  return v
}
function binding(p) {
  return {
    productRevision: p.productRevision,
    engineRevision: p.engineRevision,
    workerDigest: p.workerDigest,
    webDigest: p.webDigest,
    proxyDigest: p.proxyDigest,
    sandboxDigest: p.sandboxDigest,
  }
}
async function matchedWitness(kind, id, p) {
  const a = await verifiedArtifact(kind, id),
    r = record(a)
  ok(r.kind === kind && a.source === p.productRevision && r.owner === a.owner)
  for (const [k, v] of Object.entries(binding(p))) ok(r[k] === v)
  return r
}
async function archive(id) {
  const a = await verifiedArtifact("qualified-fleet", id),
    r = record(a),
    p = r.pair
  ok(p?.owner === a.owner && a.source === p.productRevision)
  cloud.verifyImageSources(p)
  const release = await matchedWitness("release-readback", r.releaseProof, p)
  ok(
    release.owner === p.owner &&
      release.admission === "open" &&
      release.runRecordV11 === "0" &&
      release.pendingHttpEvidence === "0" &&
      release.selectorPresent === false &&
      release.oldServingReplicas === 0 &&
      release.workerCount === 1 &&
      release.relayCount === 1
  )
  await candidateProofs(r, p)
  const continuity = record(await verifiedArtifact("continuity", r.connectionProof))
  ok(
    continuity.purpose === "fleet-authority" &&
      continuity.environment === "azure-production" &&
      s256.test(continuity.databaseIdentity) &&
      s256.test(continuity.redisUrlHash)
  )
  return r
}
async function candidateProofs(r, p) {
  const sandbox = await matchedWitness("sandbox-qualification", r.sandboxProof, p)
  ok(
    sandbox.amd64 === "passed" &&
      sandbox.arm64 === "passed" &&
      sandbox.manifestDigest === p.sandboxDigest
  )
  const financial = await matchedWitness("financial-qualification", r.financialProof, p)
  ok(
    financial.physicalCeiling === "passed" &&
      financial.crashRecovery === "passed" &&
      financial.workerLifetimeClaim === "passed"
  )
  const reader = await matchedWitness("reader-qualification", r.readerProof, p)
  ok(
    reader.pendingFinalization === "passed" &&
      reader.queueReconciliation === "passed" &&
      s256.test(reader.readerFingerprint)
  )
  verifyEngineRun(
    sandbox.publishRunId,
    sandbox.publishAttempt,
    p.engineRevision,
    "publish-sandbox.yml"
  )
  verifySandboxAttestation(p, sandbox.publishRunId, sandbox.publishAttempt)
  verifyEngineRun(financial.engineCiRunId, financial.engineCiAttempt, p.engineRevision, "ci.yml")
}
async function dashboard(path, params) {
  const u = new URL(path, "https://app.lyrashieldai.com")
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  const cookie = protectedSessionCookie()
  const res = await fetch(u, {
    headers: { cookie },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  })
  ok(res.status === 200 && res.body)
  let size = 0
  const chunks = []
  for await (const b of res.body) {
    size += b.length
    ok(size <= 1048576)
    chunks.push(b)
  }
  let json
  try {
    json = JSON.parse(Buffer.concat(chunks))
  } catch {}
  ok(json?.success === true && json.data)
  return json.data
}
async function readOne(id, p, canary) {
  const a = await verifiedArtifact("evidence", id),
    r = record(a)
  for (const k of ["workspace", "scan", "finding", "evidence"])
    ok(typeof r[k] === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(r[k]))
  ok(
    ["legacy-origin", "scan-observation"].includes(r.binding) &&
      r.purpose === (canary ? "canary" : "baseline")
  )
  ok(
    s256.test(r.openedProjection) && s256.test(r.readerProjection) && s256.test(r.manifestChecksum)
  )
  const [scan, finding] = await Promise.all([
    dashboard("/api/scans/" + r.scan, { workspaceId: r.workspace }),
    dashboard("/api/findings/" + r.finding, {
      workspaceId: r.workspace,
      ...(r.binding === "scan-observation" ? { observedInScanId: r.scan } : {}),
    }),
  ])
  ok(
    scan.id === r.scan &&
      scan.workspaceId === r.workspace &&
      scan.resultManifest?.checksum === r.manifestChecksum
  )
  ok(
    finding.id === r.finding &&
      finding.workspaceId === r.workspace &&
      finding.evidence?.some((e) => e.id === r.evidence) &&
      finding.evidenceInsights
  )
  if (r.binding === "scan-observation")
    ok(finding.evidenceInsights.evidenceObservationScanId === r.scan)
  else ok(finding.evidenceInsights.legacyEvidenceContext === true)
  if (canary)
    ok(
      finding.evidenceInsights.pendingHttpExchangeState === "PENDING" &&
        Array.isArray(finding.evidenceInsights.pendingHttpExchangeIds) &&
        finding.evidenceInsights.pendingHttpExchangeIds.length > 0
    )
  const pending = finding.evidenceInsights.pendingHttpExchangeIds ?? []
  ok(
    Array.isArray(pending) &&
      pending.length <= 10 &&
      pending.every((v) => typeof v === "string" && /^[0-9]{1,128}$/.test(v))
  )
  ok(
    pending.length
      ? finding.evidenceInsights.pendingHttpExchangeState === "PENDING"
      : finding.evidenceInsights.pendingHttpExchangeState === undefined
  )
  const pendingProjection = sha(JSON.stringify(pending))
  const reader = sha(JSON.stringify(finding.evidenceInsights))
  ok(reader === r.readerProjection)
  const opened = guest("evidence", {
    workspace: r.workspace,
    scan: r.scan,
    finding: r.finding,
    evidence: r.evidence,
    binding: r.binding,
    pendingProjection,
  })
  ok(opened === r.openedProjection)
  return id
}
function protectedApprovals(sandboxes) {
  return {
    redis: liveRedis,
    db: { readRemotePairedDrain: () => guest("drain", {}) },
    readAuthenticatedOwner,
    readProtectedRecord,
    async readQualifiedRelease() {
      const x = verifyCurrentSource(),
        a = await verifiedArtifact(
          "qualified-release",
          protectedId("PAIRED_QUALIFIED_RELEASE_SHA256")
        ),
        r = record(a)
      ok(
        r.owner === x.owner &&
          r.pair?.owner === x.owner &&
          r.pair.productRevision === x.source &&
          a.owner === x.owner &&
          a.source === x.source
      )
      // No selection flag can bypass maintenance classification; the trusted
      // classifier must have issued the specific protected mode record.
      ok(r.mode === "paired" && r.conflictingMaintenance === false && r.qualified === true)
      cloud.verifyImageSources(r.pair)
      await candidateProofs(r, r.pair)
      sandboxes.set(sha(JSON.stringify(binding(r.pair))), r.sandboxProof)
      cloud.verifyCompatibleMaintenance()
      const expected = record(await verifiedArtifact("continuity", r.connectionProof)),
        worker = guest("continuity", {})
      ok(
        expected.purpose === "fleet-authority" &&
          expected.environment === "azure-production" &&
          expected.databaseIdentity === worker.databaseIdentity &&
          expected.redisUrlHash === worker.redisUrlHash
      )
      await cloud.compareProducerConnections(r.pair, worker)
      return { mode: "paired", qualified: true, conflictingMaintenance: false, pair: r.pair }
    },
    verifyQualifiedArchive: async (id) => {
      const r = await archive(id)
      sandboxes.set(sha(JSON.stringify(binding(r.pair))), r.sandboxProof)
      return true
    },
    async verifyHeldBaselineArchive(id, expected) {
      const r = await readHeldBaselineArchive(id, expected)
      cloud.verifyImageSources(r.pair)
      await candidateProofs(r, r.pair)
      const continuity = record(await verifiedArtifact("continuity", r.connectionProof))
      ok(
        continuity.purpose === "fleet-authority" &&
          continuity.environment === "azure-production" &&
          s256.test(continuity.databaseIdentity) &&
          s256.test(continuity.redisUrlHash)
      )
      // Read-only evidence; do not populate the qualified-fleet recovery map.
      return true
    },
    async verifyRecoveryHandoff(id, oldOwner, newOwner) {
      const a = await verifiedArtifact("handoff", id),
        r = record(a)
      ok(r.sourceOwner === oldOwner && r.newOwner === newOwner)
      if (r.authorization === "original-owner") return a.owner === oldOwner
      ok(r.authorization === "approved-takeover" && a.owner === newOwner)
      return verifyEnvironmentApproval(newOwner, a.source)
    },
    async verifyArmAuthorization(id, owner) {
      const a = await verifiedArtifact("arm", id)
      ok(a.owner === owner && record(a).owner === owner)
      return verifyEnvironmentApproval(owner, a.source)
    },
    // An exact Redis value after a historical DEL/recreation is identical to an
    // uninterrupted one. Current ops storage has no exhaustive trusted mutation
    // history. These gates must block until that authority actually exists.
    async verifyAcquisitionContinuity() {
      throw new Error("Continuous acquisition history unavailable")
    },
    async proveReboundContinuity() {
      throw new Error("Continuous rebind history unavailable")
    },
    async authorizeUnappliedRetry(id) {
      const a = await verifiedArtifact(
        "rebind-approval",
        protectedId("PAIRED_RETRY_APPROVAL_SHA256")
      )
      return (
        record(a).intent === id &&
        a.owner === (await readAuthenticatedOwner()) &&
        verifyEnvironmentApproval(a.owner, a.source)
      )
    },
  }
}
export function protectedLiveAdapter() {
  const sandboxes = new Map()
  return {
    ...protectedApprovals(sandboxes),
    stageStore: vmStageStore(guest),
    async readServingRoute(role, p) {
      const r = await cloud.azureServingRoute(role, p)
      if (role === "relay")
        r.ownedGrantRefusalVerified = guest("relay", { relayHost: cloud.relayHost(p) }) === true
      return r
    },
    readReadiness: cloud.readReadiness,
    verifyZeroTrafficCandidate: cloud.verifyZeroTrafficCandidate,
    stageAtZeroTraffic: cloud.stageAtZeroTraffic,
    reactivateArchivedRevision: cloud.reactivateArchivedRevision,
    retirePreviousRevision: cloud.retirePreviousRevision,
    promoteNamedRoute: cloud.promoteNamedRoute,
    async promoteStoppedWorker(p) {
      const sandbox = await matchedWitness(
        "sandbox-qualification",
        sandboxes.get(sha(JSON.stringify(binding(p)))),
        p
      )
      for (const bytes of [sandbox.amd64UnpackedBytes, sandbox.arm64UnpackedBytes])
        ok(Number.isSafeInteger(bytes) && bytes > 0 && bytes <= 53687091200)
      ok(
        guest("stage-sandbox", {
          receipt: receipt(p),
          priorWorkerDigest: p.priorWorkerDigest,
          sandboxDigest: p.sandboxDigest,
          engineRevision: p.engineRevision,
          amd64Bytes: sandbox.amd64UnpackedBytes,
          arm64Bytes: sandbox.arm64UnpackedBytes,
        }) === true
      )
      cloud.promoteStoppedWorker(p)
    },
    async verifyRollbackAvailability(p) {
      cloud.verifyRollbackAvailability(p)
    },
    readWorker: () => guest("worker", {}),
    readPhysicalDrain: () => guest("physical", {}),
    verifySourceAndConnectionContinuity: (p) =>
      cloud.compareProducerConnections(p, guest("continuity", {})),
    async stopLegacyConsumers(p, expected) {
      ok(
        guest("stop", { receipt: receipt(p), expectedDigest: expected ?? p.priorWorkerDigest }) ===
          true
      )
    },
    async containOwnedConsumers(p) {
      ok(guest("contain", { receipt: receipt(p) }) === true)
    },
    async verifyStoppedLegacy(p, expected) {
      const s = guest("stopped", {})
      ok(
        s.image ===
          "ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@" + (expected ?? p.priorWorkerDigest)
      )
    },
    async proveStoppedOrigin(p, continuity) {
      const a = await verifiedArtifact("continuity", continuity),
        r = record(a),
        s = guest("stopped", {}),
        c = guest("continuity", {})
      return (
        s.image === "ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@" + p.workerDigest &&
        s.sandbox === "ghcr.io/ecryptoguru/lyrashield-sandbox@" + p.sandboxDigest &&
        r.databaseIdentity === c.databaseIdentity &&
        r.redisUrlHash === c.redisUrlHash
      )
    },
    proveSelectorFileAbsent: () => guest("selector-absent", {}) === true,
    async clearMatchingSelector(hash, p) {
      ok(s256.test(hash) && guest("clear", { selectorHash: hash, receipt: receipt(p) }) === true)
    },
    async proveOriginalOperationAccounted(acquisition, id) {
      const a = await verifiedArtifact(
          "operation",
          protectedId("PAIRED_ACCOUNTED_OPERATION_SHA256")
        ),
        r = record(a)
      ok(r.acquisition === acquisition && r.canaryEvidence === id)
      return (
        guest("accounted", { workspace: r.workspace, scan: r.scan, operation: r.operation }) ===
        true
      )
    },
    async readArmedSelectorProof(p, id) {
      ok(s256.test(id))
      const start = Date.now(),
        proof = guest("armed-selector", {}),
        end = Date.now(),
        { hostTimeMs, ...fields } = proof
      return {
        ...fields,
        clockVerified:
          Number.isSafeInteger(hostTimeMs) &&
          hostTimeMs >= start - 2000 &&
          hostTimeMs <= end + 2000,
        requestUnused: guest("unused", { selectorHash: id }) === true,
      }
    },
    async readRestoredEvidence(p, old, canary) {
      return {
        baselineEvidence: await readOne(old, p, false),
        canaryEvidence: await readOne(canary, p, true),
      }
    },
  }
}
