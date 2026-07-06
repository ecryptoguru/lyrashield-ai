import type { AgentActionDefinition, AgentActionContext, AgentActionResult } from "@lyrashield/types"
import { hasPermission, type Permission } from "@lyrashield/auth"
import { prisma, createApproval, getApproval, setWorkspaceContext, verifyInputHash } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"

const APPROVAL_TTL_HOURS = 24

export class ActionRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private actions = new Map<string, AgentActionDefinition<any>>()

  register<TInput>(action: AgentActionDefinition<TInput>): void {
    if (this.actions.has(action.name)) {
      throw new Error(`Action already registered: ${action.name}`)
    }
    this.actions.set(action.name, action)
  }

  list(): Array<{ name: string; description: string; permission: string }> {
    return Array.from(this.actions.values()).map((a) => ({
      name: a.name,
      description: a.description,
      permission: a.permission,
    }))
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(name: string): AgentActionDefinition<any> | undefined {
    return this.actions.get(name)
  }

  async execute(
    actionName: string,
    rawInput: unknown,
    context: AgentActionContext
  ): Promise<AgentActionResult> {
    const action = this.actions.get(actionName)
    if (!action) {
      return { success: false, error: { code: "UNKNOWN_ACTION", message: `Unknown action: ${actionName}` } }
    }

    const parsed = action.inputSchema.safeParse(rawInput)
    if (!parsed.success) {
      return {
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: parsed.error.issues[0]?.message ?? "Invalid input",
        },
      }
    }

    const input = parsed.data

    if (!hasPermission(context.role as never, action.permission as Permission)) {
      logger.warn("Agent action denied — insufficient permission", {
        action: actionName,
        userId: context.userId,
        role: context.role,
        requiredPermission: action.permission,
      })
      return { success: false, error: { code: "FORBIDDEN", message: "Insufficient permissions" } }
    }

    const needsApproval = action.needsApproval ? action.needsApproval(input) : false
    if (needsApproval && !context.approvalId) {
      const approval = await createApproval({
        workspaceId: context.workspaceId,
        actionName,
        input: input as Record<string, unknown>,
        requestedById: context.userId,
        expiresAt: new Date(Date.now() + APPROVAL_TTL_HOURS * 60 * 60 * 1000),
      })

      logger.info("Agent action requires approval", {
        action: actionName,
        approvalId: approval.id,
        userId: context.userId,
      })

      return {
        success: false,
        needsApproval: true,
        approvalId: approval.id,
        error: {
          code: "NEEDS_APPROVAL",
          message: `Action '${actionName}' requires human approval. Approval ID: ${approval.id}`,
        },
      }
    }

    if (context.approvalId) {
      const approval = await getApproval(context.approvalId, context.workspaceId)
      if (!approval) {
        return { success: false, error: { code: "APPROVAL_NOT_FOUND", message: "Approval record not found" } }
      }
      if (approval.status !== "APPROVED") {
        return {
          success: false,
          error: {
            code: "APPROVAL_NOT_APPROVED",
            message: `Approval status is ${approval.status}, not APPROVED`,
          },
        }
      }
      if (approval.expiresAt && approval.expiresAt < new Date()) {
        return { success: false, error: { code: "APPROVAL_EXPIRED", message: "Approval has expired" } }
      }
      if (approval.actionName !== actionName) {
        return {
          success: false,
          error: {
            code: "APPROVAL_MISMATCH",
            message: `Approval is for action '${approval.actionName}', not '${actionName}'`,
          },
        }
      }
      if (!verifyInputHash(actionName, input as Record<string, unknown>, approval.inputHash)) {
        return {
          success: false,
          error: {
            code: "APPROVAL_INPUT_MISMATCH",
            message: "Approval input does not match the current request input",
          },
        }
      }
    }

    setWorkspaceContext(context.workspaceId)

    try {
      const data = await action.handler(input, context)

      try {
        await prisma.auditLog.create({
          data: {
            workspaceId: context.workspaceId,
            actorUserId: context.userId,
            action: action.auditAction,
            resourceType: action.auditResourceType,
            ...(context.approvalId ? { metadata: { approvalId: context.approvalId } } : {}),
          },
        })
      } catch (auditErr) {
        logger.error("Failed to create audit log for agent action", {
          action: actionName,
          userId: context.userId,
          error: auditErr instanceof Error ? auditErr.message : String(auditErr),
        })
      }

      return { success: true, data }
    } catch (err) {
      logger.error("Agent action execution failed", {
        action: actionName,
        error: err instanceof Error ? err.message : String(err),
      })
      return {
        success: false,
        error: {
          code: "EXECUTION_ERROR",
          message: err instanceof Error ? err.message : "Action execution failed",
        },
      }
    }
  }
}
