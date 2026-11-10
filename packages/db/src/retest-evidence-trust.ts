import { isDeepStrictEqual } from "node:util"
import { DETERMINISTIC_RETEST_SCANNERS } from "@lyrashield/types"
import { z } from "zod"
import { verifyStoredManifestChecksum } from "./manifest-checksum"
import type { ScopedTransaction } from "./rls"

const deterministicScanners = new Set<string>(DETERMINISTIC_RETEST_SCANNERS)
const checksum = z.string().regex(/^[0-9a-f]{64}$/i)
const revision = z.string().regex(/^[0-9a-f]{40}$/i)
const identitySchema = z.object({
  scanId: z.string().min(1),
  manifestChecksum: checksum,
  sourceRevision: revision.nullable(),
  targetUrlChecksum: checksum.nullable(),
})
const evidenceSchema = z.object({
  retestId: z.string().min(1),
  scannerSource: z.string().min(1),
  baseline: identitySchema,
  retest: identitySchema,
  coverageReceiptIds: z.array(z.string().min(1)).min(2),
})
const manifestSchema = z.object({
  target: z.object({ id: z.string(), type: z.string(), urlChecksum: checksum.nullish() }),
  sourceExecution: z.object({ sourceRevision: revision.nullish() }).nullish(),
  engineExecution: z.object({ sourceRevision: revision.nullish() }).nullish(),
  terminalOutcome: z.object({ status: z.string() }),
  coverage: z.array(
    z.object({
      scanner: z.string(),
      controlId: z.string(),
      status: z.string(),
      reason: z.string().nullish(),
      subject: z.string().nullish(),
      metadata: z.unknown().optional(),
    })
  ),
})

type EvidenceScan = {
  id: string
  workspaceId: string
  targetId: string | null
  status: string
  resultManifest: { checksum: string; checksumInput: string | null; manifest: unknown } | null
  coverageReceipts: {
    id: string
    scanId: string
    scanner: string
    controlId: string
    status: string
    reason: string | null
    subject: string | null
    metadata: unknown
  }[]
}

/** Recheck the immutable evidence behind a claimed deterministic retest. */
export function isReceiptBackedRetest(input: {
  workspaceId: string
  targetId: string
  finding: { id: string; scanId: string }
  receipt: {
    status: string
    method: string
    scanId: string
    verifierVersion: string | null
    evidence: unknown
  }
  retest: {
    id: string
    workspaceId: string
    findingId: string
    scanId: string
    status: string
  } | null
  baseline: EvidenceScan | null
  retestScan: EvidenceScan | null
  sourceCandidates: { scannerSource: string; payload: unknown }[]
  observedInRetest: boolean
}): boolean {
  const { workspaceId, targetId, finding, receipt, retest, baseline, retestScan } = input
  const parsed = evidenceSchema.safeParse(receipt.evidence)
  if (
    !parsed.success ||
    receipt.status !== "VALIDATED" ||
    receipt.method !== "RETEST" ||
    receipt.verifierVersion !== "result-integrity-v3" ||
    !retest ||
    !baseline ||
    !retestScan ||
    input.observedInRetest
  )
    return false
  const evidence = parsed.data
  if (
    baseline.id === retestScan.id ||
    baseline.id !== finding.scanId ||
    retestScan.id !== receipt.scanId ||
    evidence.baseline.scanId !== baseline.id ||
    evidence.retest.scanId !== retestScan.id ||
    retest.id !== evidence.retestId ||
    retest.workspaceId !== workspaceId ||
    retest.findingId !== finding.id ||
    retest.scanId !== retestScan.id ||
    retest.status !== "passed" ||
    [baseline, retestScan].some(
      (scan) =>
        scan.workspaceId !== workspaceId ||
        scan.targetId !== targetId ||
        scan.status !== "COMPLETED"
    )
  )
    return false

  const manifests = [baseline, retestScan].map((scan) => {
    if (verifyStoredManifestChecksum(scan.resultManifest) !== "MATCH") return null
    const parsedManifest = manifestSchema.safeParse(scan.resultManifest?.manifest)
    return parsedManifest.success ? parsedManifest.data : null
  })
  const [original, current] = manifests
  if (
    !original ||
    !current ||
    original.target.id !== targetId ||
    current.target.id !== targetId ||
    original.target.type !== current.target.type ||
    !["REPO", "WEB_APP", "API"].includes(original.target.type) ||
    original.terminalOutcome.status !== "COMPLETED" ||
    current.terminalOutcome.status !== "COMPLETED" ||
    baseline.resultManifest?.checksum !== evidence.baseline.manifestChecksum ||
    retestScan.resultManifest?.checksum !== evidence.retest.manifestChecksum
  )
    return false

  const storedIdentities = [original, current].map((manifest) => ({
    sourceRevision:
      manifest.sourceExecution?.sourceRevision ?? manifest.engineExecution?.sourceRevision ?? null,
    targetUrlChecksum: manifest.target.urlChecksum ?? null,
  }))
  if (
    storedIdentities[0]!.sourceRevision !== evidence.baseline.sourceRevision ||
    storedIdentities[1]!.sourceRevision !== evidence.retest.sourceRevision ||
    storedIdentities[0]!.targetUrlChecksum !== evidence.baseline.targetUrlChecksum ||
    storedIdentities[1]!.targetUrlChecksum !== evidence.retest.targetUrlChecksum ||
    (original.target.type === "REPO"
      ? !evidence.baseline.sourceRevision || !evidence.retest.sourceRevision
      : !evidence.baseline.targetUrlChecksum ||
        evidence.baseline.targetUrlChecksum !== evidence.retest.targetUrlChecksum)
  )
    return false

  const sources = [
    ...new Set(input.sourceCandidates.map((candidate) => candidate.scannerSource)),
  ].sort()
  if (
    sources.length === 0 ||
    sources.some((source) => !deterministicScanners.has(source)) ||
    sources.join("+") !== evidence.scannerSource ||
    input.sourceCandidates.some((candidate) => {
      const payload = candidate.payload
      return Boolean(
        payload &&
        typeof payload === "object" &&
        "findingClass" in payload &&
        typeof payload.findingClass === "string" &&
        payload.findingClass.startsWith("php_runtime_")
      )
    })
  )
    return false

  const coverage = [baseline, retestScan].flatMap((scan) =>
    scan.coverageReceipts.filter((row) => sources.includes(row.controlId))
  )
  const receiptIds = new Set(evidence.coverageReceiptIds)
  const coverageMatchesManifest = [baseline, retestScan].every((scan, index) =>
    sources.every((source) => {
      const bound = manifests[index]!.coverage.filter((entry) => entry.controlId === source)
      const rows = scan.coverageReceipts.filter((row) => row.controlId === source)
      if (bound.length !== 1 || rows.length !== 1) return false
      const entry = bound[0]!
      const row = rows[0]!
      return (
        entry.scanner === row.scanner &&
        entry.status === "COMPLETED" &&
        entry.status === row.status &&
        (entry.reason ?? null) === row.reason &&
        (entry.subject ?? null) === row.subject &&
        isDeepStrictEqual(entry.metadata ?? null, row.metadata)
      )
    })
  )
  return (
    coverageMatchesManifest &&
    receiptIds.size === evidence.coverageReceiptIds.length &&
    coverage.length === receiptIds.size &&
    coverage.every((row) => receiptIds.has(row.id) && row.status === "COMPLETED") &&
    [baseline.id, retestScan.id].every((scanId) =>
      sources.every((source) =>
        coverage.some((row) => row.scanId === scanId && row.controlId === source)
      )
    )
  )
}

/** Load all referenced records under the caller's workspace RLS transaction. */
export async function loadReceiptBackedRetestFindingIds(
  tx: ScopedTransaction,
  input: {
    workspaceId: string
    targetId: string
    findings: {
      id: string
      scanId: string
      dedupeKey: string
      verificationReceipts: {
        status: string
        method: string
        scanId: string
        verifierVersion: string | null
        evidence: unknown
      }[]
    }[]
  }
): Promise<Set<string>> {
  const entries = input.findings.flatMap((finding) => {
    const receipt = finding.verificationReceipts[0]
    const evidence = evidenceSchema.safeParse(receipt?.evidence)
    return receipt && evidence.success ? [{ finding, receipt, evidence: evidence.data }] : []
  })
  if (entries.length === 0) return new Set()
  const scanIds = [
    ...new Set(entries.flatMap(({ finding, receipt }) => [finding.scanId, receipt.scanId])),
  ]
  const retestScanIds = [...new Set(entries.map(({ receipt }) => receipt.scanId))]
  const findingIds = entries.map(({ finding }) => finding.id)
  const [scans, retests, candidates] = await Promise.all([
    tx.scan.findMany({
      where: {
        id: { in: scanIds },
        workspaceId: input.workspaceId,
        targetId: input.targetId,
        deletedAt: null,
      },
      select: {
        id: true,
        workspaceId: true,
        targetId: true,
        status: true,
        resultManifest: { select: { checksum: true, checksumInput: true, manifest: true } },
        coverageReceipts: {
          select: {
            id: true,
            scanId: true,
            scanner: true,
            controlId: true,
            status: true,
            reason: true,
            subject: true,
            metadata: true,
          },
        },
      },
    }),
    tx.retest.findMany({
      where: {
        workspaceId: input.workspaceId,
        id: { in: entries.map(({ evidence }) => evidence.retestId) },
        findingId: { in: findingIds },
      },
      select: { id: true, workspaceId: true, findingId: true, scanId: true, status: true },
    }),
    tx.findingCandidate.findMany({
      where: {
        workspaceId: input.workspaceId,
        targetId: input.targetId,
        scanId: { in: scanIds },
        OR: [{ findingId: { in: findingIds } }, { scanId: { in: retestScanIds } }],
      },
      select: {
        findingId: true,
        scanId: true,
        dedupeKey: true,
        scannerSource: true,
        payload: true,
      },
    }),
  ])
  const scansById = new Map(scans.map((scan) => [scan.id, scan]))
  const retestsById = new Map(retests.map((retest) => [retest.id, retest]))
  const trusted = new Set<string>()
  for (const { finding, receipt, evidence } of entries) {
    const sourceCandidates = candidates.filter(
      (candidate) => candidate.scanId === finding.scanId && candidate.findingId === finding.id
    )
    const legacyKeys = new Set(
      sourceCandidates.flatMap((candidate) => {
        const payload = candidate.payload
        return payload &&
          typeof payload === "object" &&
          !Array.isArray(payload) &&
          payload.dependencyIdentityVersion === undefined &&
          typeof payload.dedupeKey === "string"
          ? [payload.dedupeKey]
          : []
      })
    )
    const observedInRetest = candidates.some((candidate) => {
      if (candidate.scanId !== receipt.scanId) return false
      if (candidate.findingId === finding.id || candidate.dedupeKey === finding.dedupeKey)
        return true
      const payload = candidate.payload
      return Boolean(
        payload &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        payload.dependencyIdentityVersion === "composer-lock/1" &&
        typeof payload.dependencyLegacyDedupeKey === "string" &&
        legacyKeys.has(payload.dependencyLegacyDedupeKey)
      )
    })
    if (
      isReceiptBackedRetest({
        workspaceId: input.workspaceId,
        targetId: input.targetId,
        finding,
        receipt,
        retest: retestsById.get(evidence.retestId) ?? null,
        baseline: scansById.get(finding.scanId) ?? null,
        retestScan: scansById.get(receipt.scanId) ?? null,
        sourceCandidates,
        observedInRetest,
      })
    )
      trusted.add(finding.id)
  }
  return trusted
}
