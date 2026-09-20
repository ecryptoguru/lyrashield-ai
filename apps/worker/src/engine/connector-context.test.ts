import { beforeEach, describe, expect, it, vi } from "vitest"

const { invokeConnectorTool, readEncryptedArtifact } = vi.hoisted(() => ({
  invokeConnectorTool: vi.fn(),
  readEncryptedArtifact: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({
  invokeConnectorTool,
  isConnectorProvider: (v: string) => v === "github" || v === "slack",
}))

vi.mock("@lyrashield/evidence-storage", () => ({
  readEncryptedArtifact,
}))

vi.mock("@lyrashield/config", () => ({
  env: {
    SLACK_CLIENT_ID: "x",
    SLACK_CLIENT_SECRET: "y",
    OUTBOUND_CONNECTOR_ADMISSION: "off",
    CONNECTOR_CANARY_WORKSPACE_IDS: "",
  },
}))

import { invokeScanConnectorTool } from "./connector-context"

const WORKSPACE = "ws-1"

function githubConnection(metadata: Record<string, unknown> = {}) {
  return {
    id: "int-gh",
    workspaceId: WORKSPACE,
    type: "GITHUB",
    externalId: "777",
    metadata,
    configRef: null,
  } as never
}

describe("invokeScanConnectorTool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invokeConnectorTool.mockResolvedValue({ ok: true, operationId: "op-1", replayed: false })
  })

  it("denies unknown tools before touching the service", async () => {
    const result = await invokeScanConnectorTool({
      workspaceId: WORKSPACE,
      toolName: "github.delete_repo",
      input: {},
      idempotencyKey: "k1",
    })
    expect(result).toMatchObject({ ok: false, code: "INPUT_INVALID" })
    expect(invokeConnectorTool).not.toHaveBeenCalled()
  })

  it("forwards tool spec, resource derivation, and the cap hook to the service", async () => {
    await invokeScanConnectorTool({
      workspaceId: WORKSPACE,
      scanId: "scan-1",
      toolName: "github.get_repository",
      input: { owner: "acme", repo: "app" },
      idempotencyKey: "k2",
    })
    expect(invokeConnectorTool).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE,
        provider: "github",
        scanId: "scan-1",
        idempotencyKey: "k2",
      })
    )
    const args = invokeConnectorTool.mock.calls[0]![0] as {
      tool: { name: string; requiredScope: string }
      resourceOf: (input: Record<string, unknown>) => string | undefined
    }
    expect(args.tool.name).toBe("github.get_repository")
    expect(args.tool.requiredScope).toBe("repo:metadata")
    expect(args.resourceOf({ owner: "acme", repo: "app" })).toBe("repo:acme/app")
  })

  it("forwards the sponsor's effective plan for the service-side gate", async () => {
    await invokeScanConnectorTool({
      workspaceId: WORKSPACE,
      sponsorEffectivePlan: "ENTERPRISE",
      toolName: "github.get_repository",
      input: { owner: "acme", repo: "app" },
      idempotencyKey: "k-plan",
    })
    expect(invokeConnectorTool).toHaveBeenCalledWith(
      expect.objectContaining({ sponsorEffectivePlan: "ENTERPRISE" })
    )
  })

  it("resolves github credentials from the connection's installation id", async () => {
    await invokeScanConnectorTool({
      workspaceId: WORKSPACE,
      toolName: "github.get_repository",
      input: { owner: "acme", repo: "app" },
      idempotencyKey: "k3",
    })
    const args = invokeConnectorTool.mock.calls[0]![0] as {
      resolveCredential: (conn: never) => Promise<unknown>
    }
    const cred = await args.resolveCredential(githubConnection({ installationId: 4242 }))
    expect(cred).toEqual({ kind: "github_installation", installationId: 4242 })
  })

  it("falls back to a numeric externalId for github installation id", async () => {
    await invokeScanConnectorTool({
      workspaceId: WORKSPACE,
      toolName: "github.get_repository",
      input: { owner: "acme", repo: "app" },
      idempotencyKey: "k4",
    })
    const args = invokeConnectorTool.mock.calls[0]![0] as {
      resolveCredential: (conn: never) => Promise<unknown>
    }
    // metadata.installationId wins; numeric externalId is the fallback.
    const cred = await args.resolveCredential(githubConnection())
    expect(cred).toEqual({ kind: "github_installation", installationId: 777 })
    const missing = await args.resolveCredential(
      githubConnection({ installationId: undefined }) &&
        ({ ...githubConnection(), externalId: "not-a-number" } as never)
    )
    expect(missing).toBeNull()
  })

  it("reads the sealed slack bot token by configRef — never from metadata", async () => {
    readEncryptedArtifact.mockResolvedValue({
      content: Buffer.from(JSON.stringify({ botToken: "xoxb-real" })),
    })
    await invokeScanConnectorTool({
      workspaceId: WORKSPACE,
      toolName: "slack.list_channels",
      input: {},
      idempotencyKey: "k5",
    })
    const args = invokeConnectorTool.mock.calls[0]![0] as {
      resolveCredential: (conn: never) => Promise<unknown>
    }
    const connection = {
      id: "int-slack",
      workspaceId: WORKSPACE,
      type: "SLACK",
      externalId: "T1",
      metadata: { teamId: "T1" },
      configRef: "s3://bucket/evidence/ws-1/connector",
    } as never
    const cred = await args.resolveCredential(connection)
    expect(cred).toEqual({ kind: "slack_bot", botToken: "xoxb-real" })
    expect(readEncryptedArtifact).toHaveBeenCalledWith(
      "s3://bucket/evidence/ws-1/connector",
      WORKSPACE
    )
  })

  it("returns null credential for a slack connection without configRef", async () => {
    await invokeScanConnectorTool({
      workspaceId: WORKSPACE,
      toolName: "slack.list_channels",
      input: {},
      idempotencyKey: "k6",
    })
    const args = invokeConnectorTool.mock.calls[0]![0] as {
      resolveCredential: (conn: never) => Promise<unknown>
    }
    const connection = {
      id: "int-slack",
      workspaceId: WORKSPACE,
      type: "SLACK",
      externalId: "T1",
      metadata: {},
      configRef: null,
    } as never
    expect(await args.resolveCredential(connection)).toBeNull()
    expect(readEncryptedArtifact).not.toHaveBeenCalled()
  })
})
