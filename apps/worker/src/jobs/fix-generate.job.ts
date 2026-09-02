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
import { FIX_GENERATE_QUEUE_NAME } from "@lyrashield/integrations"

export const FIX_GENERATE_QUEUE = FIX_GENERATE_QUEUE_NAME

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

  try {
    // Phase 1 — read under RLS, compute the diff, validate. No artifact I/O
    // inside the DB transaction: holding an RLS transaction open across S3
    // round-trips needlessly extends row locks and, on a post-upload rollback,
    // would orphan the uploaded artifact with no compensating cleanup.
    const prepared = await withWorkspaceRLS(workspaceId, async (tx) => {
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
      if (!proposal) return { skip: "proposal not found" as const }
      if (!proposal.finding) return { skip: "finding not found" as const }
      // Idempotent re-run guard: a proposal that already reached `ready` has a
      // stored, checksum-bound patch. Re-generating would silently rewrite the
      // diffRef an approval may already be bound to — skip instead.
      if (proposal.status === "ready") return { skip: "proposal already ready" as const }
      if (proposal.status === "failed")
        return { skip: "proposal previously failed validation" as const }

      const finding = proposal.finding

      // The engine's structured fix lives in the finding's evidence (claim_context
      // / code_location artifacts). Pull the latest code_location with a fix.
      const evidence = await tx.evidence.findMany({
        where: { findingId: finding.id, type: "code_location" },
        select: { storageUri: true },
        orderBy: { createdAt: "desc" },
      })

      return { finding, evidence }
    })

    if ("skip" in prepared) {
      return { status: "skipped", reason: prepared.skip }
    }

    const { finding, evidence } = prepared

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

    // Resolve the plan for the scope policy (read outside the transaction —
    // plan resolution needs no row locks).
    const workspace = await withWorkspaceRLS(workspaceId, (tx) =>
      tx.workspace.findUnique({
        where: { id: workspaceId },
        select: { plan: true },
      })
    )
    const policy = patchScopeForPlan(workspace?.plan ?? "STARTER")

    // Validate the generated diff against the plan-tiered scope before storing.
    const validation = validatePatchDiff(diff, anchorFile, implicatedFiles, policy)
    if (!validation.ok) {
      await withWorkspaceRLS(workspaceId, (tx) =>
        tx.fixProposal.update({
          where: { id: fixProposalId },
          data: { status: "failed" },
        })
      )
      logger.warn("Generated fix failed scope validation", {
        fixProposalId,
        code: validation.code,
      })
      return { status: "rejected", reason: validation.reason }
    }

    // Store the diff in evidence storage (encrypted, workspace-scoped). ownerId
    // follows the finding-evidence convention (the finding this patch fixes).
    // The artifact is content-addressed (`fix-${fixProposalId}`), so a failure
    // of the linking transaction below leaves an orphaned-but-harmless artifact
    // that a retry re-uploads to the same key.
    const artifact = await uploadEncryptedArtifact({
      workspaceId,
      ownerId: finding.id,
      type: "fix-patch",
      content: diff,
      artifactId: `fix-${fixProposalId}`,
      contentType: "text/x-diff; charset=utf-8",
    })

    const checksum = diffChecksum(diff)

    // Phase 2 — short transaction to link the patch to the proposal and stamp
    // the finding's fix-PR fields. Nothing above holds locks across this.
    const linked = await withWorkspaceRLS(workspaceId, async (tx) => {
      // Re-read status inside the linking transaction: a concurrent run may
      // have marked this proposal ready or failed while we were uploading.
      const current = await tx.fixProposal.findUnique({
        where: { id: fixProposalId },
        select: { status: true },
      })
      if (current?.status === "ready") return false
      await tx.fixProposal.update({
        where: { id: fixProposalId },
        data: { diffRef: artifact.storageUri, status: "ready" },
      })
      await tx.finding.update({
        where: { id: finding.id },
        data: { implicatedFiles },
      })
      return true
    })
    if (!linked) {
      return { status: "skipped", reason: "proposal already ready" }
    }

    logger.info("Fix patch generated and stored", {
      fixProposalId,
      findingId: finding.id,
      diffRef: artifact.storageUri,
      diffChecksum: checksum,
      linesTouched: validation.linesTouched,
    })

    return { status: "stored", diffRef: artifact.storageUri }
  } catch (error) {
    // A thrown error (not a named rejection above) is infrastructure, not a
    // verdict on the diff. Keep the proposal in its current (draft) state so a
    // BullMQ retry re-attempts generation rather than burying it as failed.
    logger.error("Fix generation job errored", {
      fixProposalId,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
