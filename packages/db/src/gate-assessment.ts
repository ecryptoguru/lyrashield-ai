import { createHash } from "node:crypto"
import { GATE_ASSESSMENT_VERSION, type GateAssessmentSnapshot } from "@lyrashield/gate"
import { RESULT_MANIFEST_VERSION } from "@lyrashield/types"

// Compatibility is exact: only the version the producer stamps is readable —
// older snapshots and ahead-of-reader manifests both fail closed.
const SUPPORTED_MANIFEST_VERSION = RESULT_MANIFEST_VERSION
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i
const ARTIFACT_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/i

export function toEpochMs(value: Date | null | undefined): number | null {
  return value ? value.getTime() : null
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    )
  }
  return value
}

export function fingerprintPolicy(policy: Record<string, unknown> | null): string | null {
  if (!policy) return null
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(policy)))
    .digest("hex")
}

export function snapshotFromManifest(input: {
  scanId: string
  endedAt: Date | null
  policyId: string | null
  policyFingerprint: string | null
  manifest: { version: number; checksum: string; manifest: unknown } | null
}): GateAssessmentSnapshot | null {
  const manifest = input.manifest
  if (
    !manifest ||
    manifest.version !== SUPPORTED_MANIFEST_VERSION ||
    !input.endedAt ||
    !input.policyId ||
    !input.policyFingerprint
  ) {
    return null
  }
  const raw = manifest.manifest as {
    engineExecution?: { sourceRevision?: unknown } | null
    sourceExecution?: { sourceRevision?: unknown } | null
    target?: { artifactDigest?: unknown } | null
  }
  const revision = raw.sourceExecution?.sourceRevision ?? raw.engineExecution?.sourceRevision
  const artifactDigest = raw.target?.artifactDigest
  const identity =
    typeof revision === "string" && COMMIT_PATTERN.test(revision)
      ? { kind: "COMMIT" as const, value: revision }
      : typeof artifactDigest === "string" && ARTIFACT_DIGEST_PATTERN.test(artifactDigest)
        ? { kind: "ARTIFACT_DIGEST" as const, value: artifactDigest }
        : null
  if (!identity) return null
  return {
    version: GATE_ASSESSMENT_VERSION,
    scanId: input.scanId,
    completedAtMs: input.endedAt.getTime(),
    manifestChecksum: manifest.checksum,
    manifestVersion: manifest.version,
    policyId: input.policyId,
    policyFingerprint: input.policyFingerprint,
    identity,
  }
}

export function isTrustedRetestReceipt(
  receipt: {
    status: string
    method: string
    scanId: string
    verifierVersion: string | null
    evidence: unknown
  },
  sourceScanId: string
): boolean {
  if (
    receipt.status !== "VALIDATED" ||
    receipt.method !== "RETEST" ||
    !receipt.verifierVersion?.startsWith("result-integrity-")
  ) {
    return false
  }
  const evidence = receipt.evidence as {
    baseline?: { scanId?: unknown } | null
    retest?: { scanId?: unknown } | null
  } | null
  return evidence?.baseline?.scanId === sourceScanId && evidence.retest?.scanId === receipt.scanId
}

export function parseAssessmentSnapshot(value: unknown): GateAssessmentSnapshot | null {
  if (!value || typeof value !== "object") return null
  const snapshot = value as Partial<GateAssessmentSnapshot>
  if (
    snapshot.version !== GATE_ASSESSMENT_VERSION ||
    typeof snapshot.scanId !== "string" ||
    typeof snapshot.completedAtMs !== "number" ||
    typeof snapshot.manifestChecksum !== "string" ||
    snapshot.manifestVersion !== SUPPORTED_MANIFEST_VERSION ||
    typeof snapshot.policyId !== "string" ||
    typeof snapshot.policyFingerprint !== "string" ||
    !snapshot.identity ||
    (snapshot.identity.kind !== "COMMIT" && snapshot.identity.kind !== "ARTIFACT_DIGEST") ||
    typeof snapshot.identity.value !== "string"
  ) {
    return null
  }
  return snapshot as GateAssessmentSnapshot
}
