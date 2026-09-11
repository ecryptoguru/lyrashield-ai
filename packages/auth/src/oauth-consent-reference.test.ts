import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@lyrashield/db", () => {
  const mockPrisma = {
    workspaceMember: { findUnique: vi.fn() },
    agentConnection: { findFirst: vi.fn() },
  }
  return {
    prisma: mockPrisma,
    withWorkspaceRLS: (_workspaceId: string, callback: (tx: typeof mockPrisma) => unknown) =>
      callback(mockPrisma),
  }
})

import { prisma } from "@lyrashield/db"
import {
  OAUTH_PENDING_CONNECTION_REFERENCE,
  oauthConsentReferenceId,
} from "./oauth-consent-reference"

const member = vi.mocked(prisma.workspaceMember.findUnique)
const connection = vi.mocked(prisma.agentConnection.findFirst)

function session(fields: Record<string, unknown> = {}) {
  return { activeWorkspaceId: "ws_1", id: "sess_1", userId: "user_1", ...fields }
}

describe("oauthConsentReferenceId", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    member.mockResolvedValue({ status: "active" } as never)
  })

  it("returns undefined for scopes that do not need a workspace", async () => {
    await expect(
      oauthConsentReferenceId({
        user: { id: "user_1" },
        session: session(),
        scopes: ["openid", "profile"],
      })
    ).resolves.toBeUndefined()
    expect(member).not.toHaveBeenCalled()
  })

  it("returns undefined when there is no session", async () => {
    await expect(
      oauthConsentReferenceId({
        user: { id: "user_1" },
        session: null,
        scopes: ["lyrashield.read"],
      })
    ).resolves.toBeUndefined()
  })

  it("returns a synthetic pending reference before the connection exists", async () => {
    // The select-workspace continue runs consentReferenceId BEFORE the
    // consent form creates the AgentConnection — this is the regression that
    // failed every first-time delegated connection at workspace selection.
    await expect(
      oauthConsentReferenceId({
        user: { id: "user_1" },
        session: session(),
        scopes: ["lyrashield.read", "lyrashield.write"],
      })
    ).resolves.toBe(`ws_1:${OAUTH_PENDING_CONNECTION_REFERENCE}`)
    expect(connection).not.toHaveBeenCalled()
  })

  it("binds the real connection once the consent form has stamped it", async () => {
    connection.mockResolvedValueOnce({
      id: "conn_1",
      userId: "user_1",
      workspaceId: "ws_1",
      status: "ACTIVE",
    } as never)
    await expect(
      oauthConsentReferenceId({
        user: { id: "user_1" },
        session: session({ pendingAgentConnectionId: "conn_1" }),
        scopes: ["lyrashield.read"],
      })
    ).resolves.toBe("ws_1:conn_1")
    expect(connection).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "conn_1", userId: "user_1", workspaceId: "ws_1", status: "ACTIVE" },
      })
    )
  })

  it("fails closed when the stamped connection is missing or inactive", async () => {
    connection.mockResolvedValueOnce(null)
    await expect(
      oauthConsentReferenceId({
        user: { id: "user_1" },
        session: session({ pendingAgentConnectionId: "conn_gone" }),
        scopes: ["lyrashield.read"],
      })
    ).rejects.toThrow("OAUTH_CONNECTION_REQUIRED")
  })

  it("fails closed when no workspace is selected", async () => {
    member.mockResolvedValue(null)
    await expect(
      oauthConsentReferenceId({
        user: { id: "user_1" },
        session: session({ activeWorkspaceId: undefined }),
        scopes: ["lyrashield.read"],
      })
    ).rejects.toThrow("OAUTH_WORKSPACE_REQUIRED")
  })
})
