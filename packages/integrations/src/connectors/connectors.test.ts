import { beforeEach, describe, expect, it, vi } from "vitest"

const { getInstallationToken, githubFetch, getFileContent } = vi.hoisted(() => ({
  getInstallationToken: vi.fn(async () => "installation-token"),
  githubFetch: vi.fn(),
  getFileContent: vi.fn(),
}))

vi.mock("../github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github")>()
  return {
    ...actual,
    getInstallationToken,
    githubFetch,
    getFileContent,
  }
})

vi.mock("@lyrashield/config", () => ({
  env: {
    SLACK_CLIENT_ID: "slack-client-id",
    SLACK_CLIENT_SECRET: ["slack", "client", "secret"].join("-"),
    OUTBOUND_CONNECTOR_ADMISSION: "off",
    CONNECTOR_CANARY_WORKSPACE_IDS: "ws_canary",
  },
}))

import { capConnectorOutput, type ConnectorInvocationContext } from "./types"
import {
  CONNECTOR_TOOLS,
  connectorToolResource,
  getConnectorTool,
  listConnectorTools,
} from "./registry"
import { githubConnectorTools } from "./github"
import {
  SlackConnectorError,
  exchangeSlackOAuthCode,
  getSlackAuthorizeUrl,
  slackApi,
  slackConnectorTools,
} from "./slack"
import { evaluateConnectorAdmission } from "./admission"

const githubCtx: ConnectorInvocationContext = {
  workspaceId: "ws-1",
  connectionId: "int-1",
  credential: { kind: "github_installation", installationId: 42 },
  fetchFn: vi.fn() as never,
}

const slackCtx: ConnectorInvocationContext = {
  workspaceId: "ws-1",
  connectionId: "int-2",
  credential: { kind: "slack_bot", botToken: "xoxb-test" },
  fetchFn: vi.fn() as never,
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("connector tool registry", () => {
  it("every registered tool is read-only with a byte cap and a scope", () => {
    for (const tool of CONNECTOR_TOOLS) {
      expect(tool.readOnly).toBe(true)
      expect(tool.maxOutputBytes).toBeGreaterThan(0)
      expect(tool.requiredScope.length).toBeGreaterThan(0)
      expect(tool.name).toMatch(/^(github|slack)\.[a-z_]+$/)
    }
  })

  it("lists only registered tools per provider", () => {
    expect(listConnectorTools("github")).toEqual(githubConnectorTools)
    expect(listConnectorTools("slack")).toEqual(slackConnectorTools)
    expect(getConnectorTool("github.get_repository")?.provider).toBe("github")
    expect(getConnectorTool("github.delete_repo")).toBeUndefined()
    expect(getConnectorTool("slack.chat_postMessage")).toBeUndefined()
  })

  it("derives provider resources from validated input", () => {
    const repoTool = getConnectorTool("github.get_repository")!
    const input = repoTool.validateInput({ owner: "acme", repo: "app" })
    expect(input.ok).toBe(true)
    if (input.ok) {
      expect(connectorToolResource(repoTool, input.value as Record<string, unknown>)).toBe(
        "repo:acme/app"
      )
    }
    const chanTool = getConnectorTool("slack.get_channel_history")!
    const chanInput = chanTool.validateInput({ channel: "C12345" })
    expect(chanInput.ok).toBe(true)
    if (chanInput.ok) {
      expect(connectorToolResource(chanTool, chanInput.value as Record<string, unknown>)).toBe(
        "channel:C12345"
      )
    }
  })
})

describe("github connector tools", () => {
  beforeEach(() => vi.clearAllMocks())

  it("get_repository validates input and projects bounded fields", async () => {
    const tool = getConnectorTool("github.get_repository")!
    expect(tool.validateInput({ owner: "", repo: "app" }).ok).toBe(false)
    expect(tool.validateInput({ owner: "acme", repo: "../evil" }).ok).toBe(false)
    expect(tool.validateInput({ owner: "acme", repo: "app" }).ok).toBe(true)

    githubFetch.mockResolvedValueOnce(
      jsonResponse({
        id: 1,
        full_name: "acme/app",
        name: "app",
        owner: { login: "acme" },
        description: "test",
        default_branch: "main",
        private: true,
        // Fields that must NOT leak through the projection:
        secret_field: "nope",
        internal_token: "xox-secret",
      })
    )
    const validated = tool.validateInput({ owner: "acme", repo: "app" })
    if (!validated.ok) throw new Error("unreachable")
    const output = (await tool.execute(githubCtx, validated.value)) as Record<string, unknown>
    expect(output.fullName).toBe("acme/app")
    expect(output.owner).toBe("acme")
    expect("secret_field" in output).toBe(false)
    expect("internal_token" in output).toBe(false)
    // GET only — a write method would be a bug.
    expect(githubFetch.mock.calls[0]?.[1]?.method).toBe("GET")
  })

  it("list_issues excludes pull-request entries", async () => {
    const tool = getConnectorTool("github.list_issues")!
    githubFetch.mockResolvedValueOnce(
      jsonResponse([
        { number: 1, title: "Bug", state: "open", user: { login: "a" }, pull_request: {} },
        { number: 2, title: "Real issue", state: "open", user: { login: "b" } },
      ])
    )
    const validated = tool.validateInput({ owner: "acme", repo: "app", state: "open" })
    if (!validated.ok) throw new Error("unreachable")
    const output = (await tool.execute(githubCtx, validated.value)) as {
      issues: Array<{ number: number }>
    }
    expect(output.issues.map((i) => i.number)).toEqual([2])
  })

  it("get_file caps content at 64KiB", async () => {
    const tool = getConnectorTool("github.get_file")!
    const big = "y".repeat(70 * 1024)
    getFileContent.mockResolvedValueOnce(big)
    const validated = tool.validateInput({ owner: "a", repo: "b", path: "src/x.ts", ref: "main" })
    if (!validated.ok) throw new Error("unreachable")
    const output = (await tool.execute(githubCtx, validated.value)) as {
      truncated: boolean
      content: string
      contentBytes: number
    }
    expect(output.truncated).toBe(true)
    expect(output.contentBytes).toBe(70 * 1024)
    expect(output.content.length).toBe(64 * 1024)
  })

  it("get_file rejects traversal paths", () => {
    const tool = getConnectorTool("github.get_file")!
    expect(
      tool.validateInput({ owner: "a", repo: "b", path: "../etc/passwd", ref: "main" }).ok
    ).toBe(false)
  })
})

describe("slack connector tools", () => {
  beforeEach(() => vi.clearAllMocks())

  it("slackApi refuses non-allowlisted methods — the read-only boundary", async () => {
    await expect(slackApi("tok", "chat.postMessage")).rejects.toThrowError(SlackConnectorError)
    await expect(slackApi("tok", "conversations.delete")).rejects.toThrowError(
      "read-only allowlist"
    )
  })

  it("slackApi issues GET only and maps ok:false to an error", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ ok: false, error: "not_in_channel" }))
    await expect(slackApi("tok", "conversations.info", {}, fetchFn)).rejects.toThrowError(
      SlackConnectorError
    )
    expect(fetchFn.mock.calls[0]?.[1]?.method).toBe("GET")
    expect(fetchFn.mock.calls[0]?.[1]?.redirect).toBe("error")
  })

  it("list_channels projects bounded fields and passes the cursor", async () => {
    const tool = getConnectorTool("slack.list_channels")!
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        ok: true,
        channels: [
          { id: "C1", name: "general", is_private: false, num_members: 4, secret: "x" },
          { id: "C2", name: "eng", is_private: true, is_archived: false, num_members: 12 },
        ],
        response_metadata: { next_cursor: "dGVzdA==" },
      })
    )
    const validated = tool.validateInput({})
    if (!validated.ok) throw new Error("unreachable")
    const output = (await tool.execute({ ...slackCtx, fetchFn }, validated.value)) as {
      channels: Array<Record<string, unknown>>
      nextCursor: string
    }
    expect(output.channels).toHaveLength(2)
    expect(output.channels[0]).not.toHaveProperty("secret")
    expect(output.nextCursor).toBe("dGVzdA==")
  })

  it("get_channel_history validates channel ids", () => {
    const tool = getConnectorTool("slack.get_channel_history")!
    expect(tool.validateInput({ channel: "not-an-id" }).ok).toBe(false)
    expect(tool.validateInput({ channel: "C12345" }).ok).toBe(true)
  })

  it("oauth exchange posts form data and returns bounded fields", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        ok: true,
        access_token: "xoxb-abc",
        scope: "channels:read,team:read",
        team: { id: "T1", name: "Acme" },
        bot_user_id: "U1",
      })
    )
    const result = await exchangeSlackOAuthCode("code-1", "https://app/cb", fetchFn)
    expect(result.accessToken).toBe("xoxb-abc")
    expect(result.teamId).toBe("T1")
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.method).toBe("POST")
  })

  it("authorize url carries only read-only scopes", () => {
    const url = new URL(getSlackAuthorizeUrl("state-1", "https://app/cb"))
    expect(url.searchParams.get("scope")).toBe(
      "channels:read,channels:history,team:read,users:read"
    )
    expect(url.searchParams.get("scope")).not.toMatch(/write|post|admin|delete/)
    expect(url.searchParams.get("state")).toBe("state-1")
  })
})

describe("capConnectorOutput", () => {
  it("passes output under the cap through unchanged", () => {
    const result = capConnectorOutput({ a: 1 }, 1024)
    expect(result.truncated).toBe(false)
    expect(result.output).toEqual({ a: 1 })
  })

  it("replaces oversized output with a self-describing truncation marker", () => {
    const result = capConnectorOutput({ blob: "x".repeat(200_000) }, 16 * 1024)
    expect(result.truncated).toBe(true)
    const output = result.output as { _truncated: boolean; originalBytes: number; preview: string }
    expect(output._truncated).toBe(true)
    expect(output.originalBytes).toBeGreaterThan(200_000)
    expect(output.preview.length).toBeLessThanOrEqual(16 * 1024)
    expect(result.bytes).toBeLessThanOrEqual(17 * 1024)
  })
})

describe("connector admission", () => {
  it("off denies everyone, canary admits only the allowlist, malformed fails closed", () => {
    expect(
      evaluateConnectorAdmission({
        mode: "off",
        workspaceId: "ws_canary",
        canaryWorkspaceIds: "ws_canary",
      }).allowed
    ).toBe(false)
    expect(
      evaluateConnectorAdmission({
        mode: "canary",
        workspaceId: "ws_canary",
        canaryWorkspaceIds: "ws_canary,ws_two",
      }).allowed
    ).toBe(true)
    expect(
      evaluateConnectorAdmission({
        mode: "canary",
        workspaceId: "ws_other",
        canaryWorkspaceIds: "ws_canary",
      }).allowed
    ).toBe(false)
    expect(
      evaluateConnectorAdmission({
        mode: "canary",
        workspaceId: "ws_1",
        canaryWorkspaceIds: "bad id!",
      }).allowed
    ).toBe(false)
    expect(
      evaluateConnectorAdmission({ mode: "public", workspaceId: "any", canaryWorkspaceIds: "" })
        .allowed
    ).toBe(true)
  })
})
