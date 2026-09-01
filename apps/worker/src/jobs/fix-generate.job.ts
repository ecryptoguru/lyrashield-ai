/**
 * WP3 fix-proposal producer (worker job).
 *
 * Turns a finding's engine-emitted structured fix (fix_before / fix_after on a
 * code location) into a validated, content-addressed patch stored in evidence
 * storage, and links it to the fix proposal (diffRef) plus the finding's
 * implicated files + base commit. The create-pr route then has everything it
 * needs to open an approval-bound PR.
 *
 * Safety:
 * - The diff is built deterministically from the engine's fix, NOT free-form
 *   model output (no extra model call in v1 — the engine already produced the
 *   fix during the scan).
 * - The generated diff is validated against the plan-tiered scope policy before
 *   it is stored. A diff that fails validation is discarded and the proposal is
 *   marked failed with the reason — never stored as viable.
 * - Token budget: none spent here — v1 assembles the engine's structured fix
 *   rather than calling the model again. (A model-driven generation path is a
 *   separate, capped-budget follow-up.)
 */

import { logger } from "@lyrashield/logger"
import { uploadEncryptedArtifact, readEncryptedArtifact } from "@lyrashield/evidence-storage"
import {
  buildUnifiedDiff,
  validatePatchDiff,
  diffChecksum,
  patchScopeForPlan,
} from "@lyrashield/fix"
import { withWorkspaceRLS } from "@lyrashield/db"

export const FIX_GENERATE_QUEUE = "fix-generate"

export interface FixGenerateJobData {
  workspaceId: string
  fixProposalId: string
}

export interface FixGenerateJobResult {
  status: "stored" | "rejected" | "skipped"
  reason?: string
  diffRef?: string
}

/**
 * Process a fix-generation job. Reads the proposal + finding + the engine's
 * structured fix, builds and validates the diff, stores it, and links it.
 */
export async function processFixGenerateJob(
  data: FixGenerateJobData
): Promise<FixGenerateJobResult> {
  const { workspaceId, fixProposalId } = data

  return withWorkspaceRLS(workspaceId, async (tx) => {
    const proposal = await tx.fixProposal.findFirst({
      where: { id: fixProposalId, finding: { workspaceId, deletedAt: null }, deletedAt: null },
      include: {
        finding: {
          select: {
            id: true,
            targetId: true,
            baseCommit: true,
            implicatedFiles: true,
            target: { select: { type: true } },
          },
        },
      },
    })
    if (!proposal) return { status: "skipped", reason: "proposal not found" }

    const finding = proposal.finding
    if (!finding) return { status: "skipped", reason: "finding not found" }

    // The engine's structured fix lives in the finding's evidence (claim_context
    // / code_location artifacts). Pull the latest code_location with a fix.
    const evidence = await tx.evidence.findMany({
      where: { findingId: finding.id, type: "code_location" },
      select: { storageUri: true },
      orderBy: { createdAt: "desc" },
    })

    // The structured fix (fix_before/fix_after) is read from the finding's
    // stored code-location evidence content. The producer requires it; without
    // a fix-bearing code location there is nothing to assemble.
    let fixLocation: { file?: string; fix_before?: string; fix_after?: string } | null = null
    for (const ev of evidence) {
      if (!ev.storageUri) continue
      try {
        const artifact = await readEncryptedArtifact(ev.storageUri, workspaceId)
        const parsed = JSON.parse(artifact.content.toString("utf8")) as {
          file?: string
          fix_before?: string
          fix_after?: string
        }
        if (parsed.file && parsed.fix_before !== undefined && parsed.fix_after !== undefined) {
          fixLocation = parsed
          break
        }
      } catch {
        // Skip an unreadable/non-JSON artifact; try the next.
        continue
      }
    }

    if (
      !fixLocation?.file ||
      fixLocation.fix_before === undefined ||
      fixLocation.fix_after === undefined
    ) {
      return { status: "skipped", reason: "no structured fix in the finding's evidence" }
    }

    const anchorFile = fixLocation.file
    const implicatedFiles = [anchorFile]

    // Build the diff from before → after on the implicated file.
    const diff = buildUnifiedDiff(anchorFile, fixLocation.fix_before, fixLocation.fix_after)
    if (!diff) {
      return { status: "skipped", reason: "fix produced no change" }
    }

    // Resolve the plan for the scope policy.
    const workspace = await tx.workspace.findUnique({
      where: { id: workspaceId },
      select: { plan: true },
    })
    const policy = patchScopeForPlan(workspace?.plan ?? "STARTER")

    // Validate the generated diff against the plan-tiered scope before storing.
    const validation = validatePatchDiff(diff, anchorFile, implicatedFiles, policy)
    if (!validation.ok) {
      await tx.fixProposal.update({
        where: { id: fixProposalId },
        data: { status: "failed" },
      })
      logger.warn("Generated fix failed scope validation", {
        fixProposalId,
        code: validation.code,
      })
      return { status: "rejected", reason: validation.reason }
    }

    // Store the diff in evidence storage (encrypted, workspace-scoped). ownerId
    // follows the finding-evidence convention (the finding this patch fixes).
    const artifact = await uploadEncryptedArtifact({
      workspaceId,
      ownerId: finding.id,
      type: "fix-patch",
      content: diff,
      artifactId: `fix-${fixProposalId}`,
      contentType: "text/x-diff; charset=utf-8",
    })

    const checksum = diffChecksum(diff)

    // Link the patch to the proposal and stamp the finding's fix-PR fields.
    await tx.fixProposal.update({
      where: { id: fixProposalId },
      data: { diffRef: artifact.storageUri, status: "ready" },
    })
    await tx.finding.update({
      where: { id: finding.id },
      data: { implicatedFiles },
    })

    logger.info("Fix patch generated and stored", {
      fixProposalId,
      findingId: finding.id,
      diffRef: artifact.storageUri,
      diffChecksum: checksum,
      linesTouched: validation.linesTouched,
    })

    return { status: "stored", diffRef: artifact.storageUri }
  })
}
