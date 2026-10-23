import { z } from "zod"
import { env } from "@lyrashield/config"
import { createEgressProxyFetchFn } from "@lyrashield/security"
import { withWorkspaceRLS, verifyStoredManifestChecksum } from "@lyrashield/db"
import { getFileContent } from "@lyrashield/integrations"
import { readEncryptedArtifact } from "@lyrashield/evidence-storage"
import {
  buildComposerUpdateDiff,
  diffChecksum,
  type ComposerFixArtifact,
  ComposerFixArtifactSchema,
} from "@lyrashield/fix"
import { checksum } from "../engine/result-integrity/checksum"
import { regenerateComposerLock, ComposerFixUnavailableError } from "./composer-fix"

type Finding = {
  id: string
  scanId: string
  baseCommit: string | null
  targetId: string | null
  target: {
    type: string
    repoOwner: string | null
    repoName: string | null
    installationId: string | null
    deletedAt: Date | null
  } | null
}
const ClaimSchema = z
  .object({
    findingClass: z.literal("dependency_cve"),
    dependencyMetadata: z
      .object({
        package_ecosystem: z.literal("packagist"),
        package_name: z.string().regex(/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/),
        installed_version: z.string().regex(/^v?\d+\.\d+\.\d+$/),
        fixed_version: z.string().regex(/^v?\d+\.\d+\.\d+$/),
        lockfile_path: ComposerFixArtifactSchema.shape.lockPath,
      })
      .passthrough(),
  })
  .passthrough()

/** Only immutable deterministic SCA evidence can authorize dependency resolution. */
export async function prepareComposerFixProposal(params: {
  workspaceId: string
  proposalId: string
  finding: Finding
  evidence: Array<{ storageUri: string | null; type: string }>
}): Promise<ComposerFixArtifact | null> {
  const { workspaceId, proposalId, finding } = params
  let claim: z.infer<typeof ClaimSchema> | undefined
  let metadataChecksum: string | undefined
  for (const evidence of params.evidence) {
    if (evidence.type !== "claim_context" || !evidence.storageUri) continue
    const artifact = await readEncryptedArtifact(evidence.storageUri, workspaceId)
    if (artifact.content.byteLength > 1024 * 1024) continue
    try {
      const raw: unknown = JSON.parse(artifact.content.toString("utf8"))
      const parsed = ClaimSchema.safeParse(raw)
      if (parsed.success) {
        claim = parsed.data
        // Candidate hashes bind the original serialized evidence, before schema key ordering.
        metadataChecksum = checksum((raw as { dependencyMetadata: unknown }).dependencyMetadata)
        break
      }
    } catch {
      /* Other claim artifacts are not Composer update requests. */
    }
  }
  if (!claim) return null
  const target = finding.target
  if (
    !target ||
    target.type !== "REPO" ||
    target.deletedAt ||
    !target.repoOwner ||
    !target.repoName ||
    !target.installationId ||
    !finding.targetId ||
    !finding.baseCommit ||
    !/^[a-f0-9]{40}$/.test(finding.baseCommit)
  )
    throw new ComposerFixUnavailableError(
      "Composer update requires an immutable connected repository finding"
    )
  const installationId = Number(target.installationId)
  if (!Number.isSafeInteger(installationId) || installationId <= 0)
    throw new ComposerFixUnavailableError("Invalid Composer repository installation")
  const proof = await withWorkspaceRLS(workspaceId, async (tx) => ({
    candidate: await tx.findingCandidate.findFirst({
      where: {
        workspaceId,
        findingId: finding.id,
        scanId: finding.scanId,
        scannerSource: "sca",
        status: "PROMOTED",
      },
      select: { payload: true },
    }),
    manifest: await tx.scanResultManifest.findUnique({ where: { scanId: finding.scanId } }),
    coverage: await tx.scanCoverageReceipt.findFirst({
      where: { scanId: finding.scanId, controlId: "sca", status: "COMPLETED" },
    }),
    integration: await tx.integration.findFirst({
      where: {
        workspaceId,
        type: "GITHUB",
        externalId: target.installationId,
        status: "active",
        deletedAt: null,
      },
      select: { id: true },
    }),
  }))
  if (!proof.candidate)
    throw new ComposerFixUnavailableError(
      "A deterministic SCA candidate is required for automatic Composer updates"
    )
  const payload = z
    .object({
      findingClass: z.literal("dependency_cve"),
      contentHashes: z.object({ dependencyMetadata: z.string() }),
    })
    .parse(proof.candidate.payload)
  if (payload.contentHashes.dependencyMetadata !== metadataChecksum)
    throw new ComposerFixUnavailableError(
      "Composer metadata does not match the stored finding evidence"
    )
  if (!proof.manifest || verifyStoredManifestChecksum(proof.manifest) !== "MATCH")
    throw new ComposerFixUnavailableError(
      "Composer update requires a trusted stored result manifest"
    )
  const manifest = z
    .object({
      target: z.object({ id: z.string(), type: z.literal("REPO") }),
      sourceExecution: z.object({ sourceRevision: z.string() }).nullish(),
      engineExecution: z.object({ sourceRevision: z.string() }).nullish(),
      terminalOutcome: z.object({ status: z.literal("COMPLETED") }),
    })
    .parse(proof.manifest.manifest)
  if (
    manifest.target.id !== finding.targetId ||
    (manifest.sourceExecution?.sourceRevision ?? manifest.engineExecution?.sourceRevision) !==
      finding.baseCommit ||
    !proof.coverage
  )
    throw new ComposerFixUnavailableError(
      "Composer update source provenance or advisory coverage is incomplete"
    )
  if (!proof.integration)
    throw new ComposerFixUnavailableError("The repository integration is no longer active")
  const metadata = claim.dependencyMetadata
  const lockPath = metadata.lockfile_path,
    manifestPath = lockPath.replace(/\.lock$/, ".json")
  const [originalManifest, before] = await Promise.all(
    [manifestPath, lockPath].map((path) =>
      getFileContent(installationId, target.repoOwner!, target.repoName!, path, finding.baseCommit!)
    )
  )
  if (typeof originalManifest !== "string" || typeof before !== "string")
    throw new ComposerFixUnavailableError(
      "Composer manifest or lock is unavailable at the scanned commit"
    )
  const fetchFn =
    env.LYRASHIELD_EGRESS_PROXY_URL && env.LYRASHIELD_EGRESS_PROXY_SECRET
      ? createEgressProxyFetchFn({
          url: env.LYRASHIELD_EGRESS_PROXY_URL,
          secret: env.LYRASHIELD_EGRESS_PROXY_SECRET,
          connectTimeoutMs: env.LYRASHIELD_EGRESS_PROXY_CONNECT_TIMEOUT_MS,
          readTimeoutMs: env.LYRASHIELD_EGRESS_PROXY_READ_TIMEOUT_MS,
        })
      : undefined
  if (env.NODE_ENV === "production" && !fetchFn)
    throw new ComposerFixUnavailableError(
      "Composer metadata requires the configured authenticated egress proxy"
    )
  const result = await regenerateComposerLock({
    fetchFn,
    originalManifest,
    originalLock: before,
    packageName: metadata.package_name,
    fromVersion: metadata.installed_version,
    toVersion: metadata.fixed_version,
  })
  const diff = buildComposerUpdateDiff(lockPath, before, result.after)
  return {
    version: "composer-fix/1",
    workspaceId,
    targetId: finding.targetId,
    findingId: finding.id,
    proposalId,
    baseCommit: finding.baseCommit,
    manifestPath,
    lockPath,
    packageName: metadata.package_name,
    fromVersion: metadata.installed_version,
    toVersion: metadata.fixed_version,
    before,
    after: result.after,
    diff,
    diffChecksum: diffChecksum(diff),
    resolverImage: result.resolverImage,
    checks: result.checks,
    compatibility: result.compatibility,
  }
}
