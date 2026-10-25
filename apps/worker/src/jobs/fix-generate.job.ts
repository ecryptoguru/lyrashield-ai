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
  validateComposerFixArtifact,
} from "@lyrashield/fix"
import { withWorkspaceRLS } from "@lyrashield/db"
import type { FixGenerateJobData } from "@lyrashield/integrations"
import { prepareComposerFixProposal } from "./composer-fix-proposal"
import { ComposerFixUnavailableError } from "./composer-fix"
import { ZodError } from "zod"
import { resolveAccountBilling } from "@lyrashield/billing"

export interface FixGenerateJobResult {
  status: "stored" | "rejected" | "skipped"
  reason?: string
  diffRef?: string
}

async function prepareFixJob(workspaceId: string, fixProposalId: string) {
  return await withWorkspaceRLS(workspaceId, async (tx) => {
    const proposal = await tx.fixProposal.findFirst({
      where: { id: fixProposalId, finding: { workspaceId, deletedAt: null }, deletedAt: null },
      include: {
        finding: {
          select: {
            id: true,
            targetId: true,
            scanId: true,
            scan: { select: { createdById: true } },
            baseCommit: true,
            implicatedFiles: true,
            target: {
              select: {
                type: true,
                repoOwner: true,
                repoName: true,
                installationId: true,
                deletedAt: true,
              },
            },
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
    if (proposal.status !== "draft") return { skip: "proposal is no longer a draft" as const }

    const finding = proposal.finding

    // The engine's structured fix lives in the finding's evidence (claim_context
    // / code_location artifacts). Pull the latest code_location with a fix.
    const evidence = await tx.evidence.findMany({
      where: { findingId: finding.id, type: { in: ["code_location", "claim_context"] } },
      select: { storageUri: true, type: true },
      orderBy: { createdAt: "desc" },
    })

    return { finding, evidence, summary: proposal.summary }
  })
}

async function readStructuredFix(
  evidence: { type: string; storageUri: string | null }[],
  workspaceId: string
) {
  let fixLocation: { file?: string; fix_before?: string; fix_after?: string } | null = null
  for (const ev of evidence) {
    if (ev.type !== "code_location") continue
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

  return fixLocation
}

async function linkGeneratedPatch(params: {
  workspaceId: string
  fixProposalId: string
  findingId: string
  storageUri: string
  composerFix: boolean
  summary: string
  implicatedFiles: string[]
}) {
  return await withWorkspaceRLS(params.workspaceId, async (tx) => {
    // Re-read status inside the linking transaction: a concurrent run may
    // have marked this proposal ready or failed while we were uploading.
    const current = await tx.fixProposal.findUnique({
      where: { id: params.fixProposalId },
      select: { status: true },
    })
    if (current?.status !== "draft") return false
    const claimed = await tx.fixProposal.updateMany({
      where: {
        id: params.fixProposalId,
        status: "draft",
        finding: { workspaceId: params.workspaceId },
        deletedAt: null,
      },
      data: {
        diffRef: params.storageUri,
        status: "ready",
        ...(params.composerFix
          ? {
              kind: "composer_update",
              summary: `${params.summary.slice(0, 2500)}\n\nLock consistency passed. Application compatibility is unverified. Approval opens a draft PR for customer CI and review; run compatibility tests before marking it ready for merge.`,
            }
          : {}),
      },
    })
    if (claimed.count !== 1) return false
    await tx.finding.update({
      where: { id: params.findingId },
      data: { implicatedFiles: params.implicatedFiles },
    })
    return true
  })
}

async function settleFailedGeneration(workspaceId: string, fixProposalId: string) {
  await withWorkspaceRLS(workspaceId, async (tx) => {
    const current = await tx.fixProposal.findFirst({
      where: {
        id: fixProposalId,
        status: "draft",
        finding: { workspaceId, deletedAt: null },
        deletedAt: null,
      },
      select: { summary: true },
    })
    if (!current) return
    await tx.fixProposal.updateMany({
      where: { id: fixProposalId, status: "draft", finding: { workspaceId }, deletedAt: null },
      data: {
        status: "failed",
        summary: `${current.summary.slice(0, 2500)}\n\nFix generation could not complete after retries. Check metadata access, resolver availability and evidence storage, then request a new proposal.`,
      },
    })
  })
}

/**
 * Process a fix-generation job. Reads the proposal + finding + the engine's
 * structured fix, builds and validates the diff, stores it, and links it.
 */
export async function processFixGenerateJob(
  data: FixGenerateJobData,
  retry?: { attempt: number; maxAttempts: number }
): Promise<FixGenerateJobResult> {
  const { workspaceId, fixProposalId } = data

  try {
    // Phase 1 — read under RLS, compute the diff, validate. No artifact I/O
    // inside the DB transaction: holding an RLS transaction open across S3
    // round-trips needlessly extends row locks and, on a post-upload rollback,
    // would orphan the uploaded artifact with no compensating cleanup.
    const prepared = await prepareFixJob(workspaceId, fixProposalId)

    if ("skip" in prepared) {
      return { status: "skipped", reason: prepared.skip }
    }

    const { finding, evidence } = prepared
    const sponsorId = finding.scan.createdById
    const account = sponsorId ? await resolveAccountBilling(sponsorId) : null
    const policy = patchScopeForPlan(account?.effectivePlan ?? "FREE")
    let composerFix
    try {
      composerFix = await prepareComposerFixProposal({
        workspaceId,
        proposalId: fixProposalId,
        finding,
        evidence,
      })
    } catch (error) {
      if (!(error instanceof ComposerFixUnavailableError) && !(error instanceof ZodError))
        throw error
      const reason =
        error instanceof Error
          ? error.message.slice(0, 500)
          : "Automatic Composer update unavailable"
      await withWorkspaceRLS(workspaceId, (tx) =>
        tx.fixProposal.updateMany({
          where: { id: fixProposalId, status: "draft", finding: { workspaceId } },
          data: {
            status: "failed",
            summary: `${prepared.summary.slice(0, 2500)}\n\nAutomatic Composer update unavailable: ${reason}`,
          },
        })
      )
      return { status: "rejected", reason }
    }

    // The structured fix (fix_before/fix_after) is read from the finding's
    // stored code-location evidence content. The producer requires it; without
    // a fix-bearing code location there is nothing to assemble.
    const fixLocation = await readStructuredFix(evidence, workspaceId)

    if (
      !composerFix &&
      (!fixLocation?.file ||
        fixLocation.fix_before === undefined ||
        fixLocation.fix_after === undefined)
    ) {
      return { status: "skipped", reason: "no structured fix in the finding's evidence" }
    }

    const anchorFile = composerFix?.lockPath ?? fixLocation!.file!
    const implicatedFiles = [anchorFile]

    // Build the diff from before → after on the implicated file.
    const diff =
      composerFix?.diff ??
      buildUnifiedDiff(anchorFile, fixLocation!.fix_before!, fixLocation!.fix_after!)
    if (!diff) {
      return { status: "skipped", reason: "fix produced no change" }
    }

    // Resolve the plan for the scope policy (read outside the transaction —
    // plan resolution needs no row locks).
    // Validate the generated diff against the plan-tiered scope before storing.
    const validation = composerFix
      ? validateComposerFixArtifact(
          composerFix,
          {
            workspaceId,
            targetId: finding.targetId!,
            findingId: finding.id,
            proposalId: fixProposalId,
            baseCommit: finding.baseCommit!,
          },
          policy
        )
      : validatePatchDiff(diff, anchorFile, implicatedFiles, policy)
    if (!validation.ok) {
      await withWorkspaceRLS(workspaceId, (tx) =>
        tx.fixProposal.updateMany({
          where: { id: fixProposalId, status: "draft", finding: { workspaceId }, deletedAt: null },
          data: {
            status: "failed",
            summary: `${prepared.summary.slice(0, 2500)}\n\nAutomatic fix unavailable (${validation.code}): ${validation.reason.slice(0, 500)}`,
          },
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
      content: composerFix ? JSON.stringify(composerFix) : diff,
      artifactId: `fix-${fixProposalId}`,
      contentType: composerFix ? "application/json; charset=utf-8" : "text/x-diff; charset=utf-8",
    })

    const checksum = diffChecksum(diff)

    // Phase 2 — short transaction to link the patch to the proposal and stamp
    // the finding's fix-PR fields. Nothing above holds locks across this.
    const linked = await linkGeneratedPatch({
      workspaceId,
      fixProposalId,
      findingId: finding.id,
      storageUri: artifact.storageUri,
      composerFix: !!composerFix,
      summary: prepared.summary,
      implicatedFiles,
    })
    if (!linked) {
      return { status: "skipped", reason: "proposal is no longer a draft" }
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
    if (retry && retry.attempt >= retry.maxAttempts)
      await settleFailedGeneration(workspaceId, fixProposalId)
    logger.error("Fix generation job errored", {
      fixProposalId,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

/** Queue attempt context keeps transient failures retryable and settles final failure. */
export async function processQueuedFixGenerateJob(job: {
  data: FixGenerateJobData
  id?: string
  attemptsMade: number
  opts: { attempts?: number }
}) {
  const result = await processFixGenerateJob(job.data, {
    attempt: job.attemptsMade + 1,
    maxAttempts: job.opts.attempts ?? 1,
  })
  logger.info("Fix generation job processed", {
    jobId: job.id,
    fixProposalId: job.data.fixProposalId,
    status: result.status,
  })
  return result
}
