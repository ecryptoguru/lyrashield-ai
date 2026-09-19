import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  integrationFindFirst,
  integrationFindMany,
  integrationCreate,
  integrationUpdate,
  receiptUpsert,
  claimOrGetAgentOperation,
  completeAgentOperation,
  failAgentOperation,
} = vi.hoisted(() => ({
  integrationFindFirst: vi.fn(),
  integrationFindMany: vi.fn(),
  integrationCreate: vi.fn(),
  integrationUpdate: vi.fn(),
  receiptUpsert: vi.fn(),
  claimOrGetAgentOperation: vi.fn(),
  completeAgentOperation: vi.fn(),
  failAgentOperation: vi.fn(),
}))

vi.mock("./client", () => ({
  prisma: {
    integration: {
      findFirst: integrationFindFirst,
      findMany: integrationFindMany,
      create: integrationCreate,
      update: integrationUpdate,
    },
    scanCoverageReceipt: { upsert: receiptUpsert },
  },
}))

vi.mock("./rls", () => ({
  withWorkspaceRLS: vi.fn(async (_workspaceId: string, fn: (tx: unknown) => unknown) =>
    fn((await import("./client")).prisma)
  ),
}))

vi.mock("./agent-operation-service", () => ({
  claimOrGetAgentOperation,
  completeAgentOperation,
  failAgentOperation,
}))

vi.mock("@lyrashield/config", () => ({
  env: {
    OUTBOUND_CONNECTOR_ADMISSION: "off",
    CONNECTOR_CANARY_WORKSPACE_IDS: "ws_canary",
  },
}))

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  checkConnectorAuthorization,
  connectorPrincipal,
  defaultConnectorAdmission,
  invokeConnectorTool,
  setConnectorConnectionStatus,
  upsertConnectorConnection,
  type ConnectorToolSpec,
} from "./connector-service"

const WORKSPACE = "ws-1"

const tool: ConnectorToolSpec = {
  name: "github.get_repository",
  provider: "github",
  requiredScope: "repo:metadata",
  maxOutputBytes: 1024,
  validateInput: (input) => ({ ok: true, value: input }),
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "int-1",
    workspaceId: WORKSPACE,
    type: "GITHUB",
    status: "active",
    capabilities: { scopes: ["repo:metadata"], tools: [tool.name] },
    metadata: {},
    configRef: "vault://cred",
    ...overrides,
  } as never
}

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: WORKSPACE,
    provider: "github" as const,
    tool,
    input: { owner: "acme", repo: "app" },
    idempotencyKey: "idem-1",
    isAdmitted: () => true,
    resolveCredential: vi.fn(async () => ({ kind: "github_installation", installationId: 7 })),
    execute: vi.fn(async () => ({ fullName: "acme/app" })),
    ...overrides,
  }
}

function newClaim() {
  return { status: "NEW" as const, operation: { id: "op-1" } }
}

describe("connector authorization matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    claimOrGetAgentOperation.mockResolvedValue(newClaim())
    integrationFindFirst.mockResolvedValue(connection())
  })

  it("executes an authorized call and completes the operation", async () => {
    const params = baseParams()
    const result = await invokeConnectorTool(params as never)
    expect(result).toMatchObject({ ok: true, replayed: false })
    expect(params.execute).toHaveBeenCalledOnce()
    expect(completeAgentOperation).toHaveBeenCalledWith(
      "op-1",
      WORKSPACE,
      expect.objectContaining({ result: expect.objectContaining({ output: { fullName: "acme/app" } }) })
    )
    // Principal is bound to the connection row id.
    expect(claimOrGetAgentOperation).toHaveBeenCalledWith(
      expect.objectContaining({ connectorPrincipal: "connector:github:int-1" })
    )
  })

  it("denies a missing connection and records the denial", async () => {
    integrationFindFirst.mockResolvedValue(null)
    const params = baseParams()
    const result = await invokeConnectorTool(params as never)
    expect(result).toMatchObject({ ok: false, code: "CONNECTION_NOT_FOUND" })
    expect(params.execute).not.toHaveBeenCalled()
    expect(failAgentOperation).toHaveBeenCalledWith(
      "op-1",
      WORKSPACE,
      expect.objectContaining({ error: "CONNECTION_NOT_FOUND" })
    )
    // Unbound denials still carry a provider principal for audit/idempotency.
    expect(claimOrGetAgentOperation).toHaveBeenCalledWith(
      expect.objectContaining({ connectorPrincipal: "connector:github:unbound" })
    )
  })

  it("fails closed on a disabled connection with the recorded reason", async () => {
    integrationFindFirst.mockResolvedValue(
      connection({ status: "disabled", metadata: { disabledReason: "rotated" } })
    )
    const params = baseParams({ scanId: "scan-1" })
    const result = await invokeConnectorTool(params as never)
    expect(result).toMatchObject({ ok: false, code: "CONNECTION_DISABLED" })
    expect(params.execute).not.toHaveBeenCalled()
    expect(failAgentOperation).toHaveBeenCalledWith(
      "op-1",
      WORKSPACE,
      expect.objectContaining({ error: "CONNECTION_DISABLED" })
    )
    // Scan-bound denial → BLOCKED coverage receipt (explicit missing context).
    expect(receiptUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "BLOCKED",
          reason: "CONNECTION_DISABLED",
          controlId: "connector:github.get_repository",
        }),
      })
    )
  })

  it("fails closed on an expired connection grant", async () => {
    integrationFindFirst.mockResolvedValue(
      connection({ metadata: { expiresAt: "2020-01-01T00:00:00.000Z" } })
    )
    const params = baseParams({ now: () => Date.parse("2026-01-01T00:00:00.000Z") })
    const result = await invokeConnectorTool(params as never)
    expect(result).toMatchObject({ ok: false, code: "CONNECTION_EXPIRED" })
    expect(params.execute).not.toHaveBeenCalled()
  })

  it("fails closed on scope mismatch (missing required scope)", async () => {
    integrationFindFirst.mockResolvedValue(
      connection({ capabilities: { scopes: ["repo:contents"], tools: [tool.name] } })
    )
    const result = await invokeConnectorTool(baseParams() as never)
    expect(result).toMatchObject({ ok: false, code: "TOOL_NOT_GRANTED" })
  })

  it("fails closed when the tool is not granted on the connection", async () => {
    integrationFindFirst.mockResolvedValue(
      connection({ capabilities: { scopes: ["repo:metadata"], tools: ["github.get_file"] } })
    )
    const result = await invokeConnectorTool(baseParams() as never)
    expect(result).toMatchObject({ ok: false, code: "TOOL_NOT_GRANTED" })
  })

  it("fails closed when the resource is outside the granted scope", async () => {
    integrationFindFirst.mockResolvedValue(
      connection({
        capabilities: {
          scopes: ["repo:metadata"],
          tools: [tool.name],
          resources: ["repo:acme/other"],
        },
      })
    )
    const params = baseParams({ resourceOf: () => "repo:acme/app" })
    const result = await invokeConnectorTool(params as never)
    expect(result).toMatchObject({ ok: false, code: "RESOURCE_OUT_OF_SCOPE" })
    expect(params.execute).not.toHaveBeenCalled()
  })

  it("replays a completed call without re-executing", async () => {
    claimOrGetAgentOperation.mockResolvedValue({
      status: "REPLAY",
      operation: { id: "op-1", result: { output: { fullName: "acme/app" }, truncated: false } },
    })
    const params = baseParams()
    const result = await invokeConnectorTool(params as never)
    expect(result).toMatchObject({ ok: true, replayed: true, output: { fullName: "acme/app" } })
    expect(params.execute).not.toHaveBeenCalled()
    expect(completeAgentOperation).not.toHaveBeenCalled()
  })

  it("does not replay stored output once the connection is disabled", async () => {
    integrationFindFirst.mockResolvedValue(connection({ status: "disabled" }))
    claimOrGetAgentOperation.mockResolvedValue({
      status: "REPLAY",
      operation: { id: "op-1", result: { output: { secret: "data" }, truncated: false } },
    })
    const result = await invokeConnectorTool(baseParams() as never)
    expect(result).toMatchObject({ ok: false, code: "CONNECTION_DISABLED" })
  })

  it("refuses retry under the same key after a failure", async () => {
    claimOrGetAgentOperation.mockResolvedValue({
      status: "FAILED",
      operation: { id: "op-1" },
    })
    const params = baseParams()
    const result = await invokeConnectorTool(params as never)
    expect(result).toMatchObject({ ok: false, code: "UPSTREAM_FAILED" })
    expect(params.execute).not.toHaveBeenCalled()
  })

  it("returns conflict on an idempotency-key/input mismatch", async () => {
    claimOrGetAgentOperation.mockResolvedValue({ status: "CONFLICT" })
    const result = await invokeConnectorTool(baseParams() as never)
    expect(result).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" })
  })

  it("records UPSTREAM_FAILED when the provider call throws", async () => {
    const params = baseParams({
      execute: vi.fn(async () => {
        throw new Error("provider down")
      }),
      scanId: "scan-1",
    })
    const result = await invokeConnectorTool(params as never)
    expect(result).toMatchObject({ ok: false, code: "UPSTREAM_FAILED" })
    expect(failAgentOperation).toHaveBeenCalled()
    expect(receiptUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ status: "FAILED" }) })
    )
  })

  it("records INPUT_INVALID when input validation fails", async () => {
    const invalidTool: ConnectorToolSpec = {
      ...tool,
      validateInput: () => ({ ok: false, reason: "bad owner" }),
    }
    const params = baseParams({ tool: invalidTool })
    const result = await invokeConnectorTool(params as never)
    expect(result).toMatchObject({ ok: false, code: "INPUT_INVALID", reason: "bad owner" })
    expect(params.execute).not.toHaveBeenCalled()
  })

  it("denies when admission is off — no claim, no execution", async () => {
    const params = baseParams({ isAdmitted: () => false })
    const result = await invokeConnectorTool(params as never)
    expect(result).toMatchObject({ ok: false, code: "CONNECTOR_NOT_ALLOWLISTED" })
    expect(claimOrGetAgentOperation).not.toHaveBeenCalled()
  })

  it("caps oversized output before completing", async () => {
    const params = baseParams({
      execute: vi.fn(async () => ({ blob: "x".repeat(5000) })),
    })
    const result = await invokeConnectorTool(params as never)
    expect(result).toMatchObject({ ok: true, truncated: true })
    const stored = vi.mocked(completeAgentOperation).mock.calls[0]?.[2] as {
      result: { output: { _truncated: boolean } }
    }
    expect(stored.result.output._truncated).toBe(true)
  })
})

describe("reconnect preserves connection identity", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    claimOrGetAgentOperation.mockResolvedValue(newClaim())
  })

  it("revives the same row (same id) rather than recreating", async () => {
    integrationFindFirst.mockResolvedValue({
      id: "int-existing",
      workspaceId: WORKSPACE,
      type: "SLACK",
      externalId: "T123",
      status: "disabled",
      deletedAt: new Date(),
    })
    integrationUpdate.mockResolvedValue({ id: "int-existing" })

    const row = await upsertConnectorConnection({
      workspaceId: WORKSPACE,
      provider: "slack",
      externalId: "T123",
      name: "Acme Slack",
      configRef: "vault://new",
    })
    expect(row.id).toBe("int-existing")
    expect(integrationCreate).not.toHaveBeenCalled()
    expect(integrationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "int-existing" },
        data: expect.objectContaining({ status: "active", deletedAt: null }),
      })
    )
  })

  it("fails closed on a provider identity already claimed elsewhere (unique conflict)", async () => {
    // Under the workspace guard the other workspace's row is invisible — the
    // (type, externalId) unique constraint is the enforcement, surfaced as
    // ALREADY_CLAIMED rather than rebinding.
    integrationFindFirst.mockResolvedValue(null)
    const p2002 = Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
    integrationCreate.mockRejectedValue(p2002)
    await expect(
      upsertConnectorConnection({
        workspaceId: WORKSPACE,
        provider: "slack",
        externalId: "T999",
        name: "Stolen",
      })
    ).rejects.toMatchObject({ code: "ALREADY_CLAIMED" })
  })

  it("creates a new row only when none exists for the external id", async () => {
    integrationFindFirst.mockResolvedValue(null)
    integrationCreate.mockResolvedValue({ id: "int-new" })
    const row = await upsertConnectorConnection({
      workspaceId: WORKSPACE,
      provider: "slack",
      externalId: "T555",
      name: "New Slack",
    })
    expect(row.id).toBe("int-new")
    expect(integrationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ workspaceId: WORKSPACE, type: "SLACK" }),
      })
    )
  })
})

describe("checkConnectorAuthorization (pure)", () => {
  it("rejects cross-workspace claims before any state check", () => {
    const result = checkConnectorAuthorization({
      connection: connection({ workspaceId: "ws-attacker" }),
      workspaceId: WORKSPACE,
      tool,
    })
    expect(result).toMatchObject({ authorized: false, code: "WORKSPACE_MISMATCH" })
  })

  it("grants when all dimensions pass", () => {
    const result = checkConnectorAuthorization({
      connection: connection(),
      workspaceId: WORKSPACE,
      tool,
      resource: "repo:acme/app",
    })
    expect(result).toEqual({ authorized: true })
  })
})

describe("defaultConnectorAdmission", () => {
  it("off denies every workspace", () => {
    expect(defaultConnectorAdmission("ws_canary")).toBe(false)
    expect(defaultConnectorAdmission("ws-1")).toBe(false)
  })
})

describe("setConnectorConnectionStatus", () => {
  beforeEach(() => vi.clearAllMocks())

  it("records the disabled reason in metadata and keeps the row", async () => {
    integrationFindFirst.mockResolvedValue({ id: "int-1", workspaceId: WORKSPACE, metadata: {} })
    integrationUpdate.mockResolvedValue({ id: "int-1", status: "disabled" })
    const row = await setConnectorConnectionStatus({
      workspaceId: WORKSPACE,
      integrationId: "int-1",
      status: "disabled",
      reason: "key rotated",
    })
    expect(row?.status).toBe("disabled")
    expect(integrationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "disabled",
          metadata: expect.objectContaining({ disabledReason: "key rotated" }),
        }),
      })
    )
  })
})

describe("connectorPrincipal", () => {
  it("binds to the integration row id", () => {
    expect(connectorPrincipal("github", "int-1")).toBe("connector:github:int-1")
    expect(connectorPrincipal("slack")).toBe("connector:slack:unbound")
  })
})
