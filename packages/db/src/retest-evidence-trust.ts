import { isDeepStrictEqual } from "node:util"
import { DETERMINISTIC_RETEST_SCANNERS } from "@lyrashield/types"
import { z } from "zod"
import { verifyStoredManifestChecksum } from "./manifest-checksum"
import type { ScopedTransaction } from "./rls"
import type { Prisma } from "./generated/prisma"

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
type RetestFinding = {
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
}

export async function loadReceiptBackedRetestFindingIds(
  tx: ScopedTransaction,
  input: { workspaceId: string; targetId: string; findings: RetestFinding[] }
): Promise<Set<string>> {
  return loadReceiptBackedRetestFindingIdsAcrossTargets(tx, {
    workspaceId: input.workspaceId,
    findings: input.findings.map((finding) => ({ ...finding, targetId: input.targetId })),
  })
}

export async function loadReceiptBackedRetestFindingIdsAcrossTargets(
  tx: ScopedTransaction,
  input: {
    workspaceId: string
    findings: (RetestFinding & { targetId: string })[]
    bounded?: boolean
    unverifiedTargetIds?: Set<string>
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
  const targetIds = [...new Set(entries.map(({ finding }) => finding.targetId))]
  const targetId = targetIds.length === 1 ? targetIds[0]! : { in: targetIds }
  const [scans, retests] = input.bounded
    ? await Promise.all([
        tx.$queryRaw<EvidenceScan[]>`
          SELECT s."id", s."workspaceId", s."targetId", s."status"::text AS "status",
            CASE WHEN m."scanId" IS NULL THEN NULL ELSE jsonb_build_object(
              'checksum', m."checksum", 'checksumInput', m."checksumInput", 'manifest', m."manifest"
            ) END AS "resultManifest",
            COALESCE(coverage.items, '[]'::jsonb) AS "coverageReceipts"
          FROM "Scan" s
          LEFT JOIN "ScanResultManifest" m ON m."scanId" = s."id"
          LEFT JOIN LATERAL (
            SELECT jsonb_agg(to_jsonb(c)) AS items FROM (
              SELECT "id", "scanId", "scanner", "controlId", "status"::text AS "status",
                "reason", "subject", "metadata"
              FROM "ScanCoverageReceipt" WHERE "scanId" = s."id" LIMIT 513
            ) c
          ) coverage ON true
          WHERE s."workspaceId" = ${input.workspaceId} AND s."id" = ANY(${scanIds}::text[])
            AND s."targetId" = ANY(${targetIds}::text[]) AND s."deletedAt" IS NULL`,
        tx.$queryRaw<
          Array<{
            id: string
            workspaceId: string
            findingId: string
            scanId: string
            status: string
          }>
        >`
          SELECT "id", "workspaceId", "findingId", "scanId", "status"
          FROM "Retest" WHERE "workspaceId" = ${input.workspaceId}
            AND "id" = ANY(${entries.map(({ evidence }) => evidence.retestId)}::text[])
            AND "findingId" = ANY(${findingIds}::text[])`,
      ])
    : await Promise.all([
        tx.scan.findMany({
          where: {
            id: { in: scanIds },
            workspaceId: input.workspaceId,
            targetId,
            deletedAt: null,
          },
          select: {
            id: true,
            workspaceId: true,
            targetId: true,
            status: true,
            resultManifest: { select: { checksum: true, checksumInput: true, manifest: true } },
            coverageReceipts: {
              ...(input.bounded ? { take: 513 } : {}),
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
      ])
  const requestsByTarget = new Map<
    string,
    { targetId: string; scanIds: Set<string>; retestScanIds: Set<string>; findingIds: Set<string> }
  >()
  for (const { finding, receipt } of entries) {
    const request = requestsByTarget.get(finding.targetId) ?? {
      targetId: finding.targetId,
      scanIds: new Set<string>(),
      retestScanIds: new Set<string>(),
      findingIds: new Set<string>(),
    }
    request.scanIds.add(finding.scanId)
    request.scanIds.add(receipt.scanId)
    request.retestScanIds.add(receipt.scanId)
    request.findingIds.add(finding.id)
    requestsByTarget.set(finding.targetId, request)
  }
  const overloaded = new Set<string>()
  if (input.bounded) {
    for (const scan of scans) {
      if (
        scan.targetId &&
        scan.coverageReceipts.length > 512 &&
        requestsByTarget.get(scan.targetId)?.scanIds.has(scan.id)
      ) {
        overloaded.add(scan.targetId)
      }
    }
  }
  const eligibleRequests = [...requestsByTarget.values()]
    .filter((request) => !overloaded.has(request.targetId))
    .map((request) => ({
      targetId: request.targetId,
      scanIds: [...request.scanIds],
      retestScanIds: [...request.retestScanIds],
      findingIds: [...request.findingIds],
    }))
  type Candidate = {
    targetId: string
    findingId: string | null
    scanId: string
    dedupeKey: string
    scannerSource: string
    payload: Prisma.JsonValue
  }
  const candidates = input.bounded
    ? eligibleRequests.length
      ? await tx.$queryRaw<Candidate[]>`
          SELECT candidate.*
          FROM jsonb_to_recordset(${JSON.stringify(eligibleRequests)}::jsonb) AS request(
            "targetId" text, "scanIds" text[], "retestScanIds" text[], "findingIds" text[]
          )
          CROSS JOIN LATERAL (
            SELECT "targetId", "findingId", "scanId", "dedupeKey", "scannerSource", "payload"
            FROM "FindingCandidate"
            WHERE "workspaceId" = ${input.workspaceId} AND "targetId" = request."targetId"
              AND "scanId" = ANY(request."scanIds")
              AND ("findingId" = ANY(request."findingIds") OR "scanId" = ANY(request."retestScanIds"))
            LIMIT 20001
          ) AS candidate`
      : []
    : await tx.findingCandidate.findMany({
        where: {
          workspaceId: input.workspaceId,
          targetId,
          scanId: { in: scanIds },
          OR: [{ findingId: { in: findingIds } }, { scanId: { in: retestScanIds } }],
        },
        select: {
          targetId: true,
          findingId: true,
          scanId: true,
          dedupeKey: true,
          scannerSource: true,
          payload: true,
        },
      })
  if (input.bounded) {
    const counts = new Map<string, number>()
    for (const candidate of candidates)
      counts.set(candidate.targetId, (counts.get(candidate.targetId) ?? 0) + 1)
    for (const [targetId, count] of counts) if (count > 20000) overloaded.add(targetId)
    for (const targetId of overloaded) input.unverifiedTargetIds?.add(targetId)
  }
  const scansById = new Map(scans.map((scan) => [scan.id, scan]))
  const retestsById = new Map(retests.map((retest) => [retest.id, retest]))
  // Index the shared candidate set once so a dashboard batch does not perform
  // a full candidate scan for every finding.
  const key = (...parts: string[]) => JSON.stringify(parts)
  const sourcesByFinding = new Map<string, typeof candidates>()
  const sightingsByScan = new Map<
    string,
    { findingIds: Set<string>; dedupeKeys: Set<string>; legacyKeys: Set<string> }
  >()
  for (const candidate of candidates) {
    if (overloaded.has(candidate.targetId)) continue
    if (candidate.findingId) {
      const sourceKey = key(candidate.targetId, candidate.scanId, candidate.findingId)
      const sources = sourcesByFinding.get(sourceKey) ?? []
      sources.push(candidate)
      sourcesByFinding.set(sourceKey, sources)
    }
    const scanKey = key(candidate.targetId, candidate.scanId)
    const sightings = sightingsByScan.get(scanKey) ?? {
      findingIds: new Set(),
      dedupeKeys: new Set(),
      legacyKeys: new Set(),
    }
    if (candidate.findingId) sightings.findingIds.add(candidate.findingId)
    sightings.dedupeKeys.add(candidate.dedupeKey)
    const payload = candidate.payload
    if (
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      payload.dependencyIdentityVersion === "composer-lock/1" &&
      typeof payload.dependencyLegacyDedupeKey === "string"
    ) {
      sightings.legacyKeys.add(payload.dependencyLegacyDedupeKey)
    }
    sightingsByScan.set(scanKey, sightings)
  }
  const trusted = new Set<string>()
  for (const { finding, receipt, evidence } of entries) {
    if (overloaded.has(finding.targetId)) continue
    const sourceCandidates =
      sourcesByFinding.get(key(finding.targetId, finding.scanId, finding.id)) ?? []
    const sightings = sightingsByScan.get(key(finding.targetId, receipt.scanId))
    const observedInRetest = Boolean(
      sightings &&
      (sightings.findingIds.has(finding.id) ||
        sightings.dedupeKeys.has(finding.dedupeKey) ||
        sourceCandidates.some((candidate) => {
          const payload = candidate.payload
          return Boolean(
            payload &&
            typeof payload === "object" &&
            !Array.isArray(payload) &&
            payload.dependencyIdentityVersion === undefined &&
            typeof payload.dedupeKey === "string" &&
            sightings.legacyKeys.has(payload.dedupeKey)
          )
        }))
    )
    if (
      isReceiptBackedRetest({
        workspaceId: input.workspaceId,
        targetId: finding.targetId,
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
