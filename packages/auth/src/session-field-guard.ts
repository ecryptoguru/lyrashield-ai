import { APIError } from "better-auth/api"
import { prisma } from "@lyrashield/db"

/**
 * VERIFY-A-002 — better-auth's POST /update-session persists every
 * `input: true` session field verbatim, with no domain authorization. Our
 * session carries two privileged fields:
 *
 *   activeWorkspaceId          — the workspace the UI treats as current
 *   pendingAgentConnectionId   — the agent connection being bound
 *
 * Every consumer re-checks membership/ownership, but the write boundary must
 * not store a value the user could not legitimately hold — a forged field is
 * a loaded gun for any future reader that forgets to re-validate. This runs
 * in the auth `before` hook; it throws FORBIDDEN on a bad value and returns
 * undefined otherwise (allowing the write to proceed).
 */
export async function validateSessionFieldWrite(body: unknown, userId: string): Promise<void> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return
  const record = body as Record<string, unknown>

  const candidateWorkspace =
    typeof record.activeWorkspaceId === "string" ? record.activeWorkspaceId : undefined
  if (candidateWorkspace) {
    const member = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: candidateWorkspace, userId },
      },
      select: { status: true },
    })
    if (member?.status !== "active") {
      throw new APIError("FORBIDDEN", {
        code: "WORKSPACE_SELECTION_FORBIDDEN",
        message: "Cannot select a workspace without active membership",
      })
    }
  }

  const candidateConnection =
    typeof record.pendingAgentConnectionId === "string"
      ? record.pendingAgentConnectionId
      : undefined
  if (candidateConnection) {
    const connection = await prisma.agentConnection.findFirst({
      where: { id: candidateConnection, userId, status: "ACTIVE" },
      select: { id: true },
    })
    if (!connection) {
      throw new APIError("FORBIDDEN", {
        code: "CONNECTION_BINDING_FORBIDDEN",
        message: "Cannot bind a connection you do not own",
      })
    }
  }
}
