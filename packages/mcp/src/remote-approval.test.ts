import { describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { handleRemoteMcpRequest } from "./http-transport"
import type { RemoteApprovalGate } from "./create-server"
import type { ToolHandlerContext } from "./tools"

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const PROTOCOL = "2025-06-18"

function fetchStub(data: unknown = { ok: true }) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    json: async () => ({ success: true, data }),
  })) as unknown as typeof fetch
}

function ctx(fetchFn: typeof fetch): ToolHandlerContext {
  return { apiBaseUrl: "https://app.example.com", apiKey: "lsk_test", fetchFn }
}

function mcpRequest(body: unknown): Request {
  return new Request("https://app.example.com/api/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  })
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    const line = text.split("\n").find((l) => l.startsWith("data:"))
    return line ? JSON.parse(line.slice(5).trim()) : {}
  }
  return JSON.parse(text)
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "t", version: "1" } },
}

function hashInput(actionName: string, input: Record<string, unknown>): string {
  const canonical = JSON.stringify({ actionName, input })
  return createHash("sha256").update(canonical).digest("hex")
}

interface FakeApproval {
  id: string
  status: "PENDING" | "APPROVED" | "EXECUTED" | "DENIED" | "EXPIRED"
  actionName: string
  input: Record<string, unknown>
  inputHash: string
  result?: Record<string, unknown>
}

function makeFakeGate(): { gate: RemoteApprovalGate; approvals: Map<string, FakeApproval> } {
  const approvals = new Map<string, FakeApproval>()

  const gate: RemoteApprovalGate = (toolName, args) => {
    const approvalId = (args.approvalId as string | undefined) ?? undefined
    const toolArgs: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(args)) {
      if (k !== "approvalId") toolArgs[k] = v
    }

    if (!approvalId) {
      const inputHash = hashInput(toolName, toolArgs)
      const id = `apv-${approvals.size + 1}`
      const approval: FakeApproval = {
        id,
        status: "PENDING",
        actionName: toolName,
        input: toolArgs,
        inputHash,
      }
      approvals.set(id, approval)
      return {
        approved: false,
        pending: true,
        approvalId: id,
        approvalUrl: `https://app.example.com/agent-approvals/${id}`,
        reason:
          "This action requires human approval. Poll with the same arguments and approvalId once approved.",
      }
    }

    const approval = approvals.get(approvalId)
    if (!approval) return { approved: false, reason: "Approval not found" }
    if (!verifyInput(approval, toolName, toolArgs))
      return { approved: false, reason: "Input hash mismatch" }
    if (approval.status === "EXECUTED") {
      return { approved: true, result: resultFrom(approval.result) }
    }
    if (approval.status === "PENDING") {
      return {
        approved: false,
        pending: true,
        approvalId,
        approvalUrl: `https://app.example.com/agent-approvals/${approvalId}`,
        reason: "Awaiting human approval",
      }
    }
    if (approval.status !== "APPROVED") {
      return { approved: false, reason: `Approval is ${approval.status.toLowerCase()}` }
    }

    const stored = { id: "scan-1", status: "QUEUED" }
    approval.status = "EXECUTED"
    approval.result = stored
    return { approved: true, result: resultFrom(stored) }
  }

  return { gate, approvals }
}

function verifyInput(
  approval: FakeApproval,
  toolName: string,
  input: Record<string, unknown>
): boolean {
  return toolName === approval.actionName && hashInput(toolName, input) === approval.inputHash
}

function resultFrom(data: Record<string, unknown> | undefined): {
  content: Array<{ type: "text"; text: string }>
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data ?? { ok: true }) }],
  }
}

function callWithApprovalId(
  base: Record<string, unknown>,
  approvalId: string
): Record<string, unknown> {
  return { ...base, approvalId }
}

describe("handleRemoteMcpRequest (remote-oob approval)", () => {
  it("returns PENDING for a mutating tool without an approvalId", async () => {
    const fetchFn = fetchStub()
    const { gate } = makeFakeGate()

    await handleRemoteMcpRequest(mcpRequest(INIT), {
      toolContext: ctx(fetchFn),
      remoteApprovalContext: {
        workspaceId: "ws-1",
        scopes: ["write"],
        apiKeyInfo: { keyId: "k-1", createdById: "u-1" },
      },
      remoteApprovalGate: gate,
    })

    const res = await handleRemoteMcpRequest(
      mcpRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "lyrashield_run_pr_scan",
          arguments: { workspaceId: "ws-1", targetId: "t-1" },
        },
      }),
      {
        toolContext: ctx(fetchFn),
        remoteApprovalContext: {
          workspaceId: "ws-1",
          scopes: ["write"],
          apiKeyInfo: { keyId: "k-1", createdById: "u-1" },
        },
        remoteApprovalGate: gate,
      }
    )

    const body = await readJson(res)
    const result = body.result as { isError?: boolean; content?: Array<{ text: string }> }
    expect(result?.isError).toBeFalsy()
    const payload = JSON.parse(result?.content?.[0]?.text ?? "{}") as Record<string, unknown>
    expect(payload.status).toBe("PENDING")
    expect(payload.approvalId).toBeTruthy()
    expect(payload.approvalUrl).toContain("/agent-approvals/")
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("rejects a second call with a mismatched input hash", async () => {
    const fetchFn = fetchStub()
    const { gate, approvals } = makeFakeGate()
    const first = await handleRemoteMcpRequest(
      mcpRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "lyrashield_run_pr_scan",
          arguments: { workspaceId: "ws-1", targetId: "t-1" },
        },
      }),
      {
        toolContext: ctx(fetchFn),
        remoteApprovalContext: {
          workspaceId: "ws-1",
          scopes: ["write"],
          apiKeyInfo: { keyId: "k-1", createdById: "u-1" },
        },
        remoteApprovalGate: gate,
      }
    )
    const firstBody = await readJson(first)
    const firstResult = JSON.parse(
      (firstBody.result as { content?: Array<{ text: string }> })?.content?.[0]?.text ?? "{}"
    ) as Record<string, unknown>
    const approvalId = firstResult.approvalId as string

    const second = await handleRemoteMcpRequest(
      mcpRequest({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "lyrashield_run_pr_scan",
          arguments: callWithApprovalId({ workspaceId: "ws-1", targetId: "t-2" }, approvalId),
        },
      }),
      {
        toolContext: ctx(fetchFn),
        remoteApprovalContext: {
          workspaceId: "ws-1",
          scopes: ["write"],
          apiKeyInfo: { keyId: "k-1", createdById: "u-1" },
        },
        remoteApprovalGate: gate,
      }
    )

    const secondBody = await readJson(second)
    const result = secondBody.result as { isError?: boolean; content?: Array<{ text: string }> }
    expect(result?.isError).toBe(true)
    expect(result?.content?.[0]?.text).toContain("mismatch")
    expect(fetchFn).not.toHaveBeenCalled()

    const approval = approvals.get(approvalId)
    expect(approval?.status).toBe("PENDING")
  })

  it("returns the stored result after the approval is approved", async () => {
    const fetchFn = fetchStub()
    const { gate, approvals } = makeFakeGate()
    const first = await handleRemoteMcpRequest(
      mcpRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "lyrashield_run_pr_scan",
          arguments: { workspaceId: "ws-1", targetId: "t-1" },
        },
      }),
      {
        toolContext: ctx(fetchFn),
        remoteApprovalContext: {
          workspaceId: "ws-1",
          scopes: ["write"],
          apiKeyInfo: { keyId: "k-1", createdById: "u-1" },
        },
        remoteApprovalGate: gate,
      }
    )
    const firstBody = await readJson(first)
    const firstResult = JSON.parse(
      (firstBody.result as { content?: Array<{ text: string }> })?.content?.[0]?.text ?? "{}"
    ) as Record<string, unknown>
    const approvalId = firstResult.approvalId as string

    // Human approves via another channel.
    const approval = approvals.get(approvalId)
    if (approval) approval.status = "APPROVED"

    const second = await handleRemoteMcpRequest(
      mcpRequest({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "lyrashield_run_pr_scan",
          arguments: callWithApprovalId({ workspaceId: "ws-1", targetId: "t-1" }, approvalId),
        },
      }),
      {
        toolContext: ctx(fetchFn),
        remoteApprovalContext: {
          workspaceId: "ws-1",
          scopes: ["write"],
          apiKeyInfo: { keyId: "k-1", createdById: "u-1" },
        },
        remoteApprovalGate: gate,
      }
    )

    const secondBody = await readJson(second)
    const result = secondBody.result as { isError?: boolean; content?: Array<{ text: string }> }
    expect(result?.isError).toBeFalsy()
    const payload = JSON.parse(result?.content?.[0]?.text ?? "{}") as Record<string, unknown>
    expect(payload.id).toBe("scan-1")

    // Third call must replay the stored result, not fetch again.
    const third = await handleRemoteMcpRequest(
      mcpRequest({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "lyrashield_run_pr_scan",
          arguments: callWithApprovalId({ workspaceId: "ws-1", targetId: "t-1" }, approvalId),
        },
      }),
      {
        toolContext: ctx(fetchFn),
        remoteApprovalContext: {
          workspaceId: "ws-1",
          scopes: ["write"],
          apiKeyInfo: { keyId: "k-1", createdById: "u-1" },
        },
        remoteApprovalGate: gate,
      }
    )

    const thirdBody = await readJson(third)
    const thirdResult = thirdBody.result as { isError?: boolean; content?: Array<{ text: string }> }
    expect(thirdResult?.isError).toBeFalsy()
    const thirdPayload = JSON.parse(thirdResult?.content?.[0]?.text ?? "{}") as Record<
      string,
      unknown
    >
    expect(thirdPayload.id).toBe("scan-1")
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("bypasses the gate with allowMutations", async () => {
    const fetchFn = fetchStub({ id: "scan-1" })
    const res = await handleRemoteMcpRequest(
      mcpRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "lyrashield_run_pr_scan",
          arguments: { workspaceId: "ws-1", targetId: "t-1" },
        },
      }),
      { toolContext: ctx(fetchFn), allowMutations: true }
    )
    const body = await readJson(res)
    const result = body.result as { isError?: boolean }
    expect(result?.isError).toBeFalsy()
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it("refuses a mutating tool with a read-only key", async () => {
    const fetchFn = fetchStub()
    const gate: RemoteApprovalGate = (_toolName, _args, ctx) => {
      if (!ctx.scopes.includes("write")) {
        return { approved: false, reason: "API key does not have write scope" }
      }
      return {
        approved: false,
        pending: true,
        approvalId: "x",
        approvalUrl: "y",
        reason: "pending",
      }
    }
    const res = await handleRemoteMcpRequest(
      mcpRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "lyrashield_run_pr_scan",
          arguments: { workspaceId: "ws-1", targetId: "t-1" },
        },
      }),
      {
        toolContext: ctx(fetchFn),
        remoteApprovalContext: {
          workspaceId: "ws-1",
          scopes: ["read"],
          apiKeyInfo: { keyId: "k-1", createdById: "u-1" },
        },
        remoteApprovalGate: gate,
      }
    )
    const body = await readJson(res)
    const result = body.result as { isError?: boolean; content?: Array<{ text: string }> }
    expect(result?.isError).toBe(true)
    expect(result?.content?.[0]?.text).toContain("write scope")
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
