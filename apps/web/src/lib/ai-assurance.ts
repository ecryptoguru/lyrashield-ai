import {
  AI_ASSURANCE_CONTROL_IDS,
  type AiAssuranceState,
  type ArtifactManifestItem,
  type ControlEvidenceWithVersion,
  aiAssuranceStateForVersion,
} from "@lyrashield/db"
import { VIBE_SECURITY_CONTROLS } from "@lyrashield/security"

export type PublicArtifactManifestItem = {
  id: string
  filename: string
  mediaType: string
  byteLength: number
  checksum: string
}

export type PublicControlEvidenceItem = {
  evidenceId: string | null
  controlId: string
  controlTitle: string
  state: AiAssuranceState
  status: string | null
  versionId: string | null
  version: number | null
  attestation: string | null
  expiresAt: string | null
  reviewedById: string | null
  reviewedAt: string | null
  createdAt: string | null
  createdById: string | null
  artifacts: PublicArtifactManifestItem[]
}

const CONTROL_TITLE_BY_ID: Record<string, string> = Object.fromEntries(
  VIBE_SECURITY_CONTROLS.map((control) => [`vibe-${control.rank}`, control.title])
)

export function toPublicArtifactManifestItem(
  item: ArtifactManifestItem
): PublicArtifactManifestItem {
  return {
    id: item.id,
    filename: item.filename,
    mediaType: item.mediaType,
    byteLength: item.byteLength,
    checksum: item.checksum,
  }
}

export function toPublicControlEvidenceItem(
  evidence: ControlEvidenceWithVersion
): PublicControlEvidenceItem {
  const version = evidence.currentVersion
  const state = aiAssuranceStateForVersion(version)
  return {
    evidenceId: evidence.id,
    controlId: evidence.controlId,
    controlTitle: CONTROL_TITLE_BY_ID[evidence.controlId] ?? evidence.controlId,
    state,
    status: version?.status ?? null,
    versionId: version?.id ?? null,
    version: version?.version ?? null,
    attestation: version?.attestation ?? null,
    expiresAt: version?.expiresAt?.toISOString() ?? null,
    reviewedById: version?.reviewedById ?? null,
    reviewedAt: version?.reviewedAt?.toISOString() ?? null,
    createdAt: version?.createdAt.toISOString() ?? null,
    createdById: version?.createdById ?? null,
    artifacts: (version?.artifactManifest ?? []).map(toPublicArtifactManifestItem),
  }
}

export function buildControlEvidenceList(
  items: ControlEvidenceWithVersion[]
): PublicControlEvidenceItem[] {
  const byControlId = new Map(items.map((item) => [item.controlId, item]))

  return AI_ASSURANCE_CONTROL_IDS.map((controlId) => {
    const evidence = byControlId.get(controlId)
    if (evidence) return toPublicControlEvidenceItem(evidence)

    return {
      evidenceId: null,
      controlId,
      controlTitle: CONTROL_TITLE_BY_ID[controlId] ?? controlId,
      state: "EVIDENCE_REQUIRED" as AiAssuranceState,
      status: null,
      versionId: null,
      version: null,
      attestation: null,
      expiresAt: null,
      reviewedById: null,
      reviewedAt: null,
      createdAt: null,
      createdById: null,
      artifacts: [],
    }
  })
}
