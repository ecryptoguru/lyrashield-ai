/* eslint-disable security/detect-non-literal-fs-filename -- checked-in fixture reads */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Output } from "../output.js"
import { handleScan } from "../commands/scan.js"
import { createClient } from "../client.js"
import { getEffectiveCredentials } from "../credentials.js"
import { loadDefaultProject } from "../projects.js"

/**
 * Parity matrix driven by the shared scan-workflows fixture
 * (packages/types/src/fixtures/scan-workflows.json). The CLI submits the same
 * fields the SDK and MCP tools do — this pins the request body for each
 * fixture workflow case and proves depth stays an explicit --mode flag.
 */
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../types/src/fixtures/scan-workflows.json", import.meta.url)),
    "utf8"
  )
) as {
  version: string
  cases: Array<{
    name: string
    targetType: string
    request: {
      mode: string
      workflow?: string
      baseRef?: string
      headRef?: string
    }
  }>
}

vi.mock("../client.js", () => ({ createClient: vi.fn() }))
vi.mock("../credentials.js", () => ({
  getEffectiveCredentials: vi.fn(),
  requireWorkspace: vi.fn((creds: { workspaceId: string }) => creds.workspaceId),
}))
vi.mock("../projects.js", () => ({
  findOrCreateRepoTarget: vi.fn(),
  resolveRepoFromPath: vi.fn(),
  loadDefaultProject: vi.fn(),
  saveDefaultProject: vi.fn(),
}))

function makeOutput(): Output {
  return {
    json: false,
    quiet: false,
    log: vi.fn(),
    notice: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    result: vi.fn(),
    fail: vi.fn() as unknown as (error: string, exitCode?: number) => never,
  }
}

function getScanBody() {
  const call = (createClient as ReturnType<typeof vi.fn>).mock.results[0]
  if (!call) return undefined
  const client = call.value as { request: ReturnType<typeof vi.fn> }
  return client.request.mock.calls[0]?.[2] as { body?: Record<string, unknown> } | undefined
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(getEffectiveCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({
    apiKey: "lsk_test",
    workspaceId: "ws-parity",
    apiUrl: "https://app.lyrashieldai.com",
  })
  ;(createClient as ReturnType<typeof vi.fn>).mockReturnValue({
    request: vi.fn().mockResolvedValue({ id: "s-parity" }),
  })
  ;(loadDefaultProject as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
})

describe("scan workflow parity matrix (CLI)", () => {
  it.each(fixture.cases.filter((c) => c.targetType === "REPO"))(
    "forwards fixture fields verbatim: $name",
    async (fixtureCase) => {
      const { workflow, baseRef, headRef, mode } = fixtureCase.request
      const args = ["--target", "t-repo", "--mode", mode]
      if (baseRef) args.push("--base", baseRef)
      if (headRef) args.push("--head", headRef)
      // The CLI derives REVIEW_CHANGES from --base; AUTHENTICATED_ASSESSMENT
      // stays a server-side denial (the CLI cannot request it).
      if (workflow === "AUTHENTICATED_ASSESSMENT") return

      const output = makeOutput()
      expect(await handleScan(args, output)).toBe(0)

      const body = getScanBody()?.body
      expect(body).toMatchObject({ mode })
      if (baseRef) {
        expect(body).toMatchObject({
          workflow: "REVIEW_CHANGES",
          baseRef,
          ...(headRef ? { headRef } : {}),
        })
      } else {
        // Snapshot path stays free of workflow fields — depth is the only
        // explicit knob; the server owns workflow inference.
        expect(body).not.toHaveProperty("workflow")
        expect(body).not.toHaveProperty("baseRef")
        expect(body).not.toHaveProperty("headRef")
      }
      // The CLI must never ship server-owned plan fields.
      for (const key of [
        "executionPlan",
        "executionPlanHash",
        "limits",
        "capabilities",
        "planHash",
      ]) {
        expect(body).not.toHaveProperty(key)
      }
    }
  )

  it("never infers depth from the target — an omitted --mode is the documented default", async () => {
    const output = makeOutput()
    expect(await handleScan(["--target", "t-1"], output)).toBe(0)
    expect(getScanBody()?.body?.mode).toBe("STANDARD")
  })
})

describe("scan attachments (CLI)", () => {
  it("forwards repeated --attachment flags as a deduplicated attachmentIds list", async () => {
    const output = makeOutput()
    expect(
      await handleScan(
        [
          "--target",
          "t-1",
          "--attachment",
          "att-1",
          "--attachment",
          "att-2",
          "--attachment",
          "att-1",
        ],
        output
      )
    ).toBe(0)

    const body = getScanBody()?.body
    // The POST body carries the workspace-scoped ids verbatim and deduped;
    // the server keeps authoritative ownership/freshness validation.
    expect(body?.attachmentIds).toEqual(["att-1", "att-2"])
    expect(body).toMatchObject({ workspaceId: "ws-parity", targetId: "t-1" })
  })

  it("omits attachmentIds entirely when no --attachment is given", async () => {
    const output = makeOutput()
    expect(await handleScan(["--target", "t-1"], output)).toBe(0)
    expect(getScanBody()?.body).not.toHaveProperty("attachmentIds")
  })
})
