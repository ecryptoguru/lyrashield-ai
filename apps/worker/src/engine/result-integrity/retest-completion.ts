import { checksum } from "./checksum"
import { prisma, verifyStoredManifestChecksum, withWorkspaceRLS } from "@lyrashield/db"

export async function markRetestsRunning(scanId: string): Promise<void> {
  await prisma.retest.updateMany({
    where: { scanId, status: "pending" },
    data: { status: "running" },
  })
}

const DETERMINISTIC_RETEST_SCANNERS = new Set([
  "sca",
  "secrets",
  "url",
  "agent_config",
  "ai_app_security",
  "ml_supply_chain",
  "sast",
  "iac",
])
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/i
const URL_CHECKSUM_PATTERN = /^[0-9a-f]{64}$/i

type StoredManifestIdentity = {
  scanId: string
  manifestChecksum: string
  sourceRevision: string | null
  targetUrlChecksum: string | null
}

type StoredManifest = {
  checksum: string
  checksumInput: string | null
  manifest: unknown
}

function baselineManifestTargetId(manifest: StoredManifest | null | undefined): string | null {
  if (!manifest) return null
  const raw = manifest.manifest as { target?: { id?: unknown } | null }
  return typeof raw.target?.id === "string" ? raw.target.id : null
}

function baselineManifestTargetType(manifest: StoredManifest | null | undefined): string | null {
  if (!manifest) return null
  const raw = manifest.manifest as { target?: { type?: unknown } | null }
  return typeof raw.target?.type === "string" ? raw.target.type : null
}

function storedManifestIdentity(
  scanId: string,
  manifest: StoredManifest | null | undefined
): StoredManifestIdentity | null {
  if (!manifest) return null
  const raw = manifest.manifest as {
    engineExecution?: { sourceRevision?: unknown } | null
    sourceExecution?: { sourceRevision?: unknown } | null
    target?: { urlChecksum?: unknown } | null
  }
  const sourceRevision = raw.sourceExecution?.sourceRevision ?? raw.engineExecution?.sourceRevision
  const targetUrlChecksum = raw.target?.urlChecksum
  return {
    scanId,
    manifestChecksum: manifest.checksum,
    sourceRevision:
      typeof sourceRevision === "string" && SOURCE_REVISION_PATTERN.test(sourceRevision)
        ? sourceRevision
        : null,
    targetUrlChecksum:
      typeof targetUrlChecksum === "string" && URL_CHECKSUM_PATTERN.test(targetUrlChecksum)
        ? targetUrlChecksum
        : null,
  }
}

function retestReceipt(params: {
  retestId: string
  scannerSource: string
  baseline: StoredManifestIdentity | null
  retest: StoredManifestIdentity | null
  coverageReceiptIds: string[]
}) {
  const { retestId, scannerSource, baseline, retest, coverageReceiptIds } = params
  return {
    retestId,
    scannerSource,
    baseline: baseline
      ? {
          scanId: baseline.scanId,
          manifestChecksum: baseline.manifestChecksum,
          sourceRevision: baseline.sourceRevision,
          targetUrlChecksum: baseline.targetUrlChecksum,
        }
      : null,
    retest: retest
      ? {
          scanId: retest.scanId,
          manifestChecksum: retest.manifestChecksum,
          sourceRevision: retest.sourceRevision,
          targetUrlChecksum: retest.targetUrlChecksum,
        }
      : null,
    coverageReceiptIds,
  }
}

function evaluateRetestOutcome(params: {
  retestId: string
  baselineScan: { id: string; targetId: string | null }
  retestScan: { id: string; targetId: string | null }
  baselineManifest: StoredManifest | null
  retestManifest: StoredManifest | null
  baselineCoverage: { id: string; controlId: string; status: string }[]
  retestCoverage: { id: string; controlId: string; status: string }[]
  sources: string[]
}) {
  const {
    retestId,
    baselineScan,
    retestScan,
    baselineManifest,
    retestManifest,
    baselineCoverage,
    retestCoverage,
    sources,
  } = params
  const baselineChecksumValid = verifyStoredManifestChecksum(baselineManifest) === "MATCH"
  const retestChecksumValid = verifyStoredManifestChecksum(retestManifest) === "MATCH"
  const trustedBaselineManifest = baselineChecksumValid ? baselineManifest : null
  const trustedRetestManifest = retestChecksumValid ? retestManifest : null
  const baselineIdentity = storedManifestIdentity(baselineScan.id, trustedBaselineManifest)
  const retestIdentity = storedManifestIdentity(retestScan.id, trustedRetestManifest)
  const deterministicSources = sources.filter((source) => DETERMINISTIC_RETEST_SCANNERS.has(source))
  const hasEngineOrUnknownSource = sources.some(
    (source) => !DETERMINISTIC_RETEST_SCANNERS.has(source)
  )
  const scannerSource = deterministicSources.join("+")

  const baselineTargetMatches =
    baselineChecksumValid &&
    baselineIdentity?.scanId === baselineScan.id &&
    baselineScan.targetId === baselineManifestTargetId(trustedBaselineManifest)
  const retestTargetMatches =
    retestChecksumValid &&
    retestIdentity?.scanId === retestScan.id &&
    retestScan.targetId === baselineManifestTargetId(trustedRetestManifest)

  // Repository scans prove identity by exact source revision: both
  // revisions must be present and well-formed, and may legitimately differ
  // after a fix. URL/API scans prove identity by a matching URL checksum.
  const baselineType = baselineManifestTargetType(trustedBaselineManifest)
  const isRepositoryTarget = baselineType === "REPO"
  const revisionIdentityValid =
    !isRepositoryTarget ||
    (baselineIdentity !== null &&
      retestIdentity !== null &&
      baselineIdentity.sourceRevision !== null &&
      retestIdentity.sourceRevision !== null)
  const urlIdentityValid =
    isRepositoryTarget ||
    (baselineIdentity !== null &&
      retestIdentity !== null &&
      baselineIdentity.targetUrlChecksum !== null &&
      retestIdentity.targetUrlChecksum !== null &&
      baselineIdentity.targetUrlChecksum === retestIdentity.targetUrlChecksum)

  const familyReceiptComplete = (receipts: { controlId: string; status: string }[]) =>
    deterministicSources.every((source) =>
      receipts.some((receipt) => receipt.controlId === source && receipt.status === "COMPLETED")
    )
  const coverageComplete =
    familyReceiptComplete(baselineCoverage) && familyReceiptComplete(retestCoverage)

  const identityValid =
    scannerSource.length > 0 &&
    !hasEngineOrUnknownSource &&
    baselineTargetMatches &&
    retestTargetMatches &&
    baselineIdentity?.manifestChecksum !== undefined &&
    retestIdentity?.manifestChecksum !== undefined

  const terminalReceiptsComplete = [trustedBaselineManifest, trustedRetestManifest].every(
    (stored) => {
      const receipt = stored?.manifest as { terminalOutcome?: { status?: string } } | undefined
      return receipt?.terminalOutcome?.status === "COMPLETED"
    }
  )
  const canValidate =
    identityValid &&
    coverageComplete &&
    revisionIdentityValid &&
    urlIdentityValid &&
    terminalReceiptsComplete

  const evidence = retestReceipt({
    retestId,
    scannerSource,
    baseline: baselineIdentity,
    retest: retestIdentity,
    coverageReceiptIds: [
      ...baselineCoverage
        .filter((receipt) => deterministicSources.includes(receipt.controlId))
        .map((receipt) => receipt.id),
      ...retestCoverage
        .filter((receipt) => deterministicSources.includes(receipt.controlId))
        .map((receipt) => receipt.id),
    ].sort(),
  })
  if (canValidate) {
    return {
      valid: true,
      reason:
        "The originating deterministic scanner did not detect the finding in the queued retest.",
      sourceRevision: retestIdentity?.sourceRevision ?? undefined,
      evidence,
    }
  }

  const missingParts: string[] = []
  if (!baselineChecksumValid) missingParts.push("baseline result manifest checksum")
  if (!retestChecksumValid) missingParts.push("retest result manifest checksum")
  if (sources.length === 0 || hasEngineOrUnknownSource)
    missingParts.push("originating scanner is not deterministic")
  if (!baselineIdentity || !retestIdentity) missingParts.push("stored result manifest identity")
  if (!revisionIdentityValid) missingParts.push("exact repository revision identity")
  if (!urlIdentityValid) missingParts.push("URL identity checksum")
  if (!coverageComplete) missingParts.push("complete originating-scanner coverage")
  if (!terminalReceiptsComplete)
    missingParts.push("completed baseline and retest terminal receipts")
  return {
    valid: false,
    reason: `The finding was not detected, but validation evidence is incomplete: ${missingParts.join(", ")}.`,
    evidence,
  }
}

export async function completeRetestsForScan(params: {
  scanId: string
  workspaceId: string
}): Promise<void> {
  await withWorkspaceRLS(params.workspaceId, async (tx) => {
    const retests = await tx.retest.findMany({
      where: {
        scanId: params.scanId,
        workspaceId: params.workspaceId,
        status: { in: ["pending", "running"] },
      },
      include: {
        // The baseline is the finding's ORIGINAL source scan, which is what the
        // retest proves against. The retest scan itself is params.scanId.
        finding: { select: { id: true, scanId: true } },
      },
    })
    if (retests.length === 0) return

    const baselineScanIds = [...new Set(retests.map((retest) => retest.finding.scanId))]
    const [retestScan, baselineScans, candidateRows, retestFindings] = await Promise.all([
      tx.scan.findUnique({
        where: { id: params.scanId },
        select: { id: true, targetId: true },
      }),
      tx.scan.findMany({
        where: { id: { in: baselineScanIds } },
        select: { id: true, targetId: true },
      }),
      tx.findingCandidate.findMany({
        where: { scanId: { in: baselineScanIds } },
        select: { findingId: true, scanId: true, scannerSource: true },
      }),
      tx.finding.findMany({
        where: {
          workspaceId: params.workspaceId,
          deletedAt: null,
          candidates: { some: { scanId: params.scanId } },
        },
        select: { id: true },
      }),
    ])
    if (!retestScan?.targetId) {
      throw new Error(`Retest scan has no target for retest finalization: ${params.scanId}`)
    }
    const persistedFindingIds = new Set(retestFindings.map((finding) => finding.id))
    const scanById = new Map(baselineScans.map((scan) => [scan.id, scan]))

    const candidateSourcesByFinding = new Map<string, string[]>()
    for (const candidate of candidateRows) {
      if (!candidate.findingId) continue
      const sources = candidateSourcesByFinding.get(candidate.findingId) ?? []
      sources.push(candidate.scannerSource)
      candidateSourcesByFinding.set(candidate.findingId, sources)
    }

    const evidenceScanIds = [...new Set([params.scanId, ...baselineScanIds])]
    const [manifestRows, coverageRows] = await Promise.all([
      tx.scanResultManifest.findMany({
        where: { scanId: { in: evidenceScanIds } },
      }),
      tx.scanCoverageReceipt.findMany({
        where: { scanId: { in: evidenceScanIds } },
        select: { id: true, scanId: true, controlId: true, status: true },
      }),
    ])
    const manifestRowsByScanId = new Map(
      manifestRows.map((manifest) => [manifest.scanId, manifest])
    )
    const manifests = new Map<string, StoredManifest | null>()
    const coverageByScan = new Map<string, { id: string; controlId: string; status: string }[]>()
    for (const scanId of evidenceScanIds) {
      manifests.set(scanId, manifestRowsByScanId.get(scanId) ?? null)
      coverageByScan.set(scanId, [])
    }
    for (const receipt of coverageRows) {
      coverageByScan.get(receipt.scanId)?.push(receipt)
    }

    for (const retest of retests) {
      if (persistedFindingIds.has(retest.findingId)) {
        await tx.retest.update({
          where: { id: retest.id },
          data: {
            status: "failed",
            resultAfter: "The finding was detected again during this retest.",
          },
        })
        continue
      }

      const baselineScan = scanById.get(retest.finding.scanId)
      if (!baselineScan) {
        const reason =
          "The finding was not detected, but its original source scan is unavailable; validation is inconclusive."
        const idempotencyKey = checksum({
          retestId: retest.id,
          scanId: params.scanId,
          findingId: retest.findingId,
          status: "INCONCLUSIVE",
        })
        await tx.findingVerification.upsert({
          where: { idempotencyKey },
          create: {
            workspaceId: params.workspaceId,
            findingId: retest.findingId,
            scanId: params.scanId,
            status: "INCONCLUSIVE",
            method: "RETEST",
            reason,
            verifierVersion: "result-integrity-v3",
            idempotencyKey,
          },
          update: {},
        })
        await tx.retest.update({
          where: { id: retest.id },
          data: { status: "inconclusive", resultAfter: reason },
        })
        continue
      }

      const baselineManifest = manifests.get(baselineScan.id) ?? null
      const retestManifest = manifests.get(params.scanId) ?? null
      const baselineCoverage = coverageByScan.get(baselineScan.id) ?? []
      const retestCoverage = coverageByScan.get(params.scanId) ?? []
      const outcome = evaluateRetestOutcome({
        retestId: retest.id,
        baselineScan,
        retestScan,
        baselineManifest,
        retestManifest,
        baselineCoverage,
        retestCoverage,
        sources: [...new Set(candidateSourcesByFinding.get(retest.findingId) ?? [])].sort(),
      })

      if (outcome.valid) {
        const reason = outcome.reason
        const idempotencyKey = checksum({
          retestId: retest.id,
          scanId: params.scanId,
          findingId: retest.findingId,
          status: "VALIDATED",
        })
        await tx.finding.update({
          where: { id: retest.findingId },
          data: {
            status: "FIXED",
            fixedAt: new Date(),
            verified: false,
            verificationStatus: "VALIDATED",
            verificationMethod: "RETEST",
            verificationReason: reason,
          },
        })
        await tx.findingVerification.upsert({
          where: { idempotencyKey },
          create: {
            workspaceId: params.workspaceId,
            findingId: retest.findingId,
            scanId: params.scanId,
            status: "VALIDATED",
            method: "RETEST",
            reason,
            verifierVersion: "result-integrity-v3",
            sourceRevision: outcome.sourceRevision,
            evidence: outcome.evidence,
            idempotencyKey,
          },
          update: {},
        })
        await tx.retest.update({
          where: { id: retest.id },
          data: {
            status: "passed",
            resultAfter: "Finding was not detected by the originating scanner.",
          },
        })
        continue
      }

      const reason = outcome.reason
      const idempotencyKey = checksum({
        retestId: retest.id,
        scanId: params.scanId,
        findingId: retest.findingId,
        status: "INCONCLUSIVE",
      })
      await tx.findingVerification.upsert({
        where: { idempotencyKey },
        create: {
          workspaceId: params.workspaceId,
          findingId: retest.findingId,
          scanId: params.scanId,
          status: "INCONCLUSIVE",
          method: "RETEST",
          reason,
          verifierVersion: "result-integrity-v3",
          evidence: outcome.evidence,
          idempotencyKey,
        },
        update: {},
      })
      await tx.retest.update({
        where: { id: retest.id },
        data: {
          status: "inconclusive",
          resultAfter: reason,
        },
      })
    }
  })
}

export async function failTerminalRetestsForScan(scanId: string): Promise<void> {
  const scan = await prisma.scan.findUnique({ where: { id: scanId }, select: { status: true } })
  if (!scan || !["FAILED", "CANCELLED", "STOPPED_BUDGET", "TIMED_OUT"].includes(scan.status)) {
    return
  }
  await prisma.retest.updateMany({
    where: { scanId, status: { in: ["pending", "running"] } },
    data: { status: "error", resultAfter: "The retest scan did not complete successfully." },
  })
}
