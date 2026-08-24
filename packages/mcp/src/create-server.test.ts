import { describe, expect, it, vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import {
  createLyraShieldServer,
  SERVER_DESCRIPTION,
  SERVER_INSTRUCTIONS,
  SERVER_TITLE,
  SERVER_VERSION,
  SERVER_WEBSITE_URL,
} from "./create-server"
import type { ToolHandlerContext } from "./tools"

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

function fetchStub(handler?: (url: string, init: RequestInit) => unknown) {
  return vi.fn(async (url: string, init: RequestInit) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    json: async () => ({ success: true, data: handler ? handler(url, init) : { ok: true } }),
  })) as unknown as typeof fetch
}

async function connect(opts: {
  allowMutations?: boolean
  fetchFn: typeof fetch
  elicitation?: (toolName: string) => boolean
}) {
  const context: ToolHandlerContext = {
    apiBaseUrl: "http://localhost:3000",
    apiKey: "lsk_test",
    fetchFn: opts.fetchFn,
  }
  const { server } = createLyraShieldServer({
    allowMutations: opts.allowMutations,
    toolContext: context,
  })

  const clientCaps = opts.elicitation ? { elicitation: {} } : {}
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: clientCaps })

  if (opts.elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      const approve = opts.elicitation!(String(req.params.message))
      return { action: "accept", content: { approve } }
    })
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

describe("createLyraShieldServer (SDK integration)", () => {
  it("advertises the full tool set over tools/list", async () => {
    const client = await connect({ fetchFn: fetchStub() })
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining([
        "lyrashield_list_workspaces",
        "lyrashield_list_targets",
        "lyrashield_get_scan_status",
        "lyrashield_check_diff",
        "lyrashield_run_pr_scan",
        "lyrashield_explain_finding",
        "lyrashield_generate_fix_plan",
        "lyrashield_verify_fix",
        "lyrashield_create_pr_security_recap",
      ])
    )
    // Every tool advertises schemas and execution semantics supported by the
    // current stable SDK. Calls are synchronous; queued scan IDs are domain
    // results, not MCP protocol tasks.
    for (const t of tools) {
      expect(t.title).toBeTruthy()
      expect(t.inputSchema.type).toBe("object")
      expect(t.outputSchema?.type).toBe("object")
      expect(t.execution).toEqual({ taskSupport: "forbidden" })
      expect(t.annotations?.readOnlyHint).toBeTypeOf("boolean")
      expect(t.annotations?.destructiveHint).toBeTypeOf("boolean")
      expect(t.annotations?.openWorldHint).toBeTypeOf("boolean")
    }
    await client.close()
  })

  it("advertises accurate server metadata and the SDK stable protocol", async () => {
    const context: ToolHandlerContext = {
      apiBaseUrl: "http://localhost:3000",
      apiKey: "lsk_test",
      fetchFn: fetchStub(),
    }
    const { server } = createLyraShieldServer({ toolContext: context })
    const client = new Client({ name: "test-client", version: "1.0.0" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    expect(client.getServerVersion()).toMatchObject({
      name: "lyrashield-mcp",
      title: SERVER_TITLE,
      version: SERVER_VERSION,
      description: SERVER_DESCRIPTION,
      websiteUrl: SERVER_WEBSITE_URL,
    })
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS)
    expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: false } })
    expect(client.getServerCapabilities()?.tasks).toBeUndefined()
    await client.close()
  })

  it("runs a read-only tool without any approval gate", async () => {
    const fetchFn = fetchStub(() => [{ id: "ws-1", name: "Acme" }])
    const client = await connect({ fetchFn })
    const res = await client.callTool({ name: "lyrashield_list_workspaces", arguments: {} })
    expect(res.isError).toBeFalsy()
    expect(fetchFn).toHaveBeenCalledOnce()
    await client.close()
  })

  it("check_diff flags an obvious hardcoded secret locally (no network)", async () => {
    const fetchFn = fetchStub()
    const client = await connect({ fetchFn })
    const res = (await client.callTool({
      name: "lyrashield_check_diff",
      arguments: { diff: '+ const apiKey = "SECRETVALUE1234567890"' },
    })) as { content: Array<{ text: string }> }
    const payload = JSON.parse(res.content[0].text)
    expect(payload.advisory.length).toBeGreaterThan(0)
    expect(payload.advisory[0].id).toBe("hardcoded-secret")
    expect(fetchFn).not.toHaveBeenCalled()
    await client.close()
  })

  it("blocks a mutating tool when the client cannot approve (fail-closed)", async () => {
    const fetchFn = fetchStub()
    const client = await connect({ fetchFn }) // no elicitation capability, no TTY
    const res = (await client.callTool({
      name: "lyrashield_run_pr_scan",
      arguments: { workspaceId: "ws-1", targetId: "t-1" },
    })) as { isError?: boolean; content: Array<{ text: string }> }
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain("human approval")
    expect(fetchFn).not.toHaveBeenCalled()
    await client.close()
  })

  it("runs a mutating tool after elicitation approval", async () => {
    const fetchFn = fetchStub(() => ({ id: "scan-1", status: "QUEUED" }))
    const client = await connect({ fetchFn, elicitation: () => true })
    const res = (await client.callTool({
      name: "lyrashield_run_pr_scan",
      arguments: { workspaceId: "ws-1", targetId: "t-1" },
    })) as { isError?: boolean; content: Array<{ text: string }> }
    expect(res.isError).toBeFalsy()
    expect(fetchFn).toHaveBeenCalledOnce()
    const body = JSON.parse(String((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body))
    expect(body.goal).toBe("CHECK_PR")
    await client.close()
  })

  it("denies a mutating tool when elicitation is declined", async () => {
    const fetchFn = fetchStub()
    const client = await connect({ fetchFn, elicitation: () => false })
    const res = (await client.callTool({
      name: "lyrashield_verify_fix",
      arguments: { workspaceId: "ws-1", findingId: "f-1" },
    })) as { isError?: boolean }
    expect(res.isError).toBe(true)
    expect(fetchFn).not.toHaveBeenCalled()
    await client.close()
  })

  it("allowMutations bypasses the gate for trusted CI", async () => {
    const fetchFn = fetchStub(() => ({ id: "scan-2" }))
    const client = await connect({ fetchFn, allowMutations: true })
    const res = (await client.callTool({
      name: "lyrashield_run_pr_scan",
      arguments: { workspaceId: "ws-1", targetId: "t-1" },
    })) as { isError?: boolean }
    expect(res.isError).toBeFalsy()
    expect(fetchFn).toHaveBeenCalledOnce()
    await client.close()
  })

  it("generate_fix_plan is read-only (no approval), record_fix_proposal is gated", async () => {
    const fetchFn = fetchStub(() => ({ id: "f-1", title: "XSS", recommendedFix: "escape" }))
    const client = await connect({ fetchFn }) // no approval capability
    const plan = (await client.callTool({
      name: "lyrashield_generate_fix_plan",
      arguments: { workspaceId: "ws-1", findingId: "f-1" },
    })) as { isError?: boolean; content: Array<{ text: string }> }
    expect(plan.isError).toBeFalsy()
    expect(JSON.parse(plan.content[0].text).action).toBe("fix_plan")

    // Recording IS a state change and must be blocked without approval.
    const record = (await client.callTool({
      name: "lyrashield_record_fix_proposal",
      arguments: { workspaceId: "ws-1", findingId: "f-1", summary: "Escape all user input" },
    })) as { isError?: boolean }
    expect(record.isError).toBe(true)
    await client.close()
  })
})
