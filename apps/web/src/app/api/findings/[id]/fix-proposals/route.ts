import { recordedOperation } from "@/lib/recorded-operation"
import { withCookieMutation } from "../../../../../lib/api-auth"
import {
  createFixProposal,
  getFindingReference,
  withDelegatedReadAuthority,
  type DelegatedReadAuthority,
} from "@lyrashield/db"
import { prisma } from "@lyrashield/db"
import { assertOAuthDelegatedScope, requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { enqueueFixGenerate } from "@lyrashield/integrations"
import { authErrorResponse } from "../../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../../lib/api-response"
import { z } from "zod"
import {
  delegatedReadPrincipal,
  resolveDelegatedTargetReadScope,
} from "../../../../../lib/delegated-target-read-scope"

const CreateFixProposalSchema = z.object({
  workspaceId: z.string().min(1),
  summary: z.string().min(10, "Summary must be at least 10 characters"),
  diffRef: z.string().optional(),
  generatedByModel: z.string().optional(),
  safetyScore: z.number().int().min(0).max(100).optional(),
})

async function post(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    const body = await request.json()
    const parsed = CreateFixProposalSchema.safeParse(body)

    if (!parsed.success) {
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }

    const { workspaceId, summary, diffRef, generatedByModel, safetyScore } = parsed.data

    const { session, workspace } = await requirePermission(workspaceId, PERMISSIONS.fix.create)

    const finding = await getFindingReference(id, workspaceId)
    if (!finding) {
      return apiError("FINDING_NOT_FOUND", "Finding not found", 404)
    }
    if (!finding.targetId) return apiError("FINDING_NOT_FOUND", "Finding not found", 404)
    await resolveDelegatedTargetReadScope(session, workspace, finding.targetId)
    assertOAuthDelegatedScope(session, finding.targetId)
    const principal = delegatedReadPrincipal(session, workspace)

    const execute = async (
      client?: Parameters<typeof createFixProposal>[0]["client"],
      authority?: DelegatedReadAuthority
    ) => {
      const currentFinding = client
        ? await getFindingReference(id, workspaceId, client)
        : finding
      if (
        !currentFinding ||
        currentFinding.targetId !== finding.targetId ||
        (authority &&
          (!authority.targetId || !authority.allowedProfiles.includes(currentFinding.scan.mode)))
      ) {
        return apiError("FINDING_NOT_FOUND", "Finding not found", 404)
      }
      return recordedOperation(
        request,
        {
          workspaceId,
          operationName: "fix_proposal.create",
          input: { ...parsed.data, findingId: id },
          session,
        },
        async () => {
        const proposal = await createFixProposal({
          findingId: id,
          workspaceId,
          targetId: currentFinding.targetId ?? undefined,
          requireActiveTarget: Boolean(principal),
          ...(client ? { client } : {}),
          summary,
          ...(diffRef ? { diffRef } : {}),
          ...(generatedByModel ? { generatedByModel } : {}),
          ...(safetyScore != null ? { safetyScore } : {}),
        })

        // Supplied references remain supported for recording drafts; they do not
        // establish generated provenance for PR execution (fix-pr-context checks it).
        // WP3 producer: a proposal without a caller-supplied patch is enqueued for
        // deterministic generation from the finding's engine-emitted structured
        // fix. Best-effort — the proposal exists and can be regenerated; a queue
        // outage must not fail the API response.
        if (!diffRef) {
          try {
            await enqueueFixGenerate({ workspaceId, fixProposalId: proposal.id })
          } catch (enqueueError) {
            logger.error("Failed to enqueue fix generation (proposal remains draft)", {
              fixProposalId: proposal.id,
              error: enqueueError instanceof Error ? enqueueError.message : String(enqueueError),
            })
          }
        }

        await prisma.auditLog.create({
          data: {
            workspaceId,
            actorUserId: session.userId,
            action: "fix_proposal.created",
            resourceType: "fix_proposal",
            resourceId: proposal.id,
          },
        })

        return apiSuccess(proposal)
        }
      )
    }

    // Await inside the try so authority/write failures reach this
    // route's error mapping instead of escaping as unhandled rejections.
    return await (principal
      ? withDelegatedReadAuthority(
          {
            ...principal,
            targetId: finding.targetId,
            requiredOperation: "fix_proposal.create",
            requiredProfile: finding.scan.mode,
          },
          (tx, authority) => execute(tx, authority)
        )
      : execute())
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to create fix proposal", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to create fix proposal", 500)
  }
}

export const POST = withCookieMutation(post)
