import { readFile } from "node:fs/promises"
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Output } from "../output.js"
import { handleScan } from "../commands/scan.js"
import { createClient } from "../client.js"
import { getEffectiveCredentials } from "../credentials.js"
import {
  findOrCreateRepoTarget,
  resolveRepoFromPath,
  loadDefaultProject,
  saveDefaultProject,
} from "../projects.js"

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }))

vi.mock("../client.js", () => ({
  createClient: vi.fn(),
}))

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

const mockRepo = {
  repoProvider: "github",
  repoOwner: "ecryptoguru",
  repoName: "lyrashield-ai",
  repoFullName: "ecryptoguru/lyrashield-ai",
}

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
    workspaceId: "ws-current",
    apiUrl: "https://app.lyrashieldai.com",
  })
  ;(createClient as ReturnType<typeof vi.fn>).mockReturnValue({
    request: vi.fn().mockResolvedValue({ id: "s-123" }),
  })
})

describe("handleScan", () => {
  it("preserves an explicit numeric-looking idempotency key as text", async () => {
    const output = makeOutput()
    expect(await handleScan(["--target", "t-1", "--idempotency-key", "00123"], output)).toBe(0)
    expect(getScanBody()).toMatchObject({ headers: { "Idempotency-Key": "00123" } })
  })

  it("defaults to STANDARD mode for a general scan", async () => {
    ;(loadDefaultProject as ReturnType<typeof vi.fn>).mockResolvedValue({
      workspaceId: "ws-current",
      targetId: "t-existing",
      name: "existing",
    })
    const output = makeOutput()
    const code = await handleScan(["--target", "t-existing"], output)
    expect(code).toBe(0)

    const body = getScanBody()?.body
    expect(body).toMatchObject({
      workspaceId: "ws-current",
      targetId: "t-existing",
      goal: "TEST_APP",
      mode: "STANDARD",
    })
  })

  it("respects an explicit mode", async () => {
    ;(loadDefaultProject as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    const output = makeOutput()
    const code = await handleScan(["--target", "t-1", "--mode", "SAFE"], output)
    expect(code).toBe(0)

    const body = getScanBody()?.body
    expect(body).toMatchObject({ mode: "SAFE" })
  })

  it("auto-detects a repo and saves the current workspace", async () => {
    ;(loadDefaultProject as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    ;(resolveRepoFromPath as ReturnType<typeof vi.fn>).mockResolvedValue({
      repo: mockRepo,
      cwd: "/tmp/repo",
    })
    ;(findOrCreateRepoTarget as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "t-123",
      name: "lyrashield-ai",
    })

    const output = makeOutput()
    const code = await handleScan(["--auto"], output)
    expect(code).toBe(0)

    expect(saveDefaultProject).toHaveBeenCalledWith({
      workspaceId: "ws-current",
      targetId: "t-123",
      name: "lyrashield-ai",
      repository: "ecryptoguru/lyrashield-ai",
    })

    const body = getScanBody()?.body
    expect(body).toMatchObject({ targetId: "t-123", mode: "STANDARD" })
  })

  it("ignores a stale default project from a different workspace", async () => {
    ;(loadDefaultProject as ReturnType<typeof vi.fn>).mockResolvedValue({
      workspaceId: "ws-stale",
      targetId: "t-stale",
      name: "stale",
    })
    ;(resolveRepoFromPath as ReturnType<typeof vi.fn>).mockResolvedValue({
      repo: mockRepo,
      cwd: "/tmp/repo",
    })
    ;(findOrCreateRepoTarget as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "t-123",
      name: "lyrashield-ai",
    })

    const output = makeOutput()
    const code = await handleScan(["--auto"], output)
    expect(code).toBe(0)

    expect(saveDefaultProject).toHaveBeenCalledWith({
      workspaceId: "ws-current",
      targetId: "t-123",
      name: "lyrashield-ai",
      repository: "ecryptoguru/lyrashield-ai",
    })

    const body = getScanBody()?.body
    expect(body).toMatchObject({ targetId: "t-123" })
  })

  it("resolves a full git repo URL", async () => {
    ;(loadDefaultProject as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    ;(findOrCreateRepoTarget as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "t-123",
      name: "lyrashield-ai",
    })

    const output = makeOutput()
    const code = await handleScan(
      ["--repo", "https://github.com/ecryptoguru/lyrashield-ai.git", "--name", "myproject"],
      output
    )
    expect(code).toBe(0)

    expect(findOrCreateRepoTarget).toHaveBeenCalledWith(
      expect.any(Object),
      "ws-current",
      mockRepo,
      "myproject"
    )
  })

  it("uses an explicit repo instead of a saved default project", async () => {
    ;(loadDefaultProject as ReturnType<typeof vi.fn>).mockResolvedValue({
      workspaceId: "ws-current",
      targetId: "t-default",
      name: "default",
    })
    ;(findOrCreateRepoTarget as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "t-explicit",
      name: "lyrashield-ai",
    })

    const output = makeOutput()
    const code = await handleScan(["--repo", "ecryptoguru/lyrashield-ai"], output)

    expect(code).toBe(0)
    expect(findOrCreateRepoTarget).toHaveBeenCalledWith(
      expect.any(Object),
      "ws-current",
      mockRepo,
      undefined
    )
    expect(getScanBody()?.body).toMatchObject({ targetId: "t-explicit" })
  })

  it("rejects an invalid repo string", async () => {
    ;(loadDefaultProject as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    const output = makeOutput()
    const code = await handleScan(["--repo", "not-a-repo"], output)
    expect(code).toBe(2)
    expect(output.error).toHaveBeenCalledWith("Invalid repo format: not-a-repo")
  })
})

describe("SARIF submission", () => {
  it("does not submit a billable scan for an unreadable SARIF file", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"))
    const output = makeOutput()
    expect(await handleScan(["--target", "t-1", "--sarif", "missing.sarif"], output)).toBe(2)
    expect((await createClient()).request).not.toHaveBeenCalled()
  })

  it("imports into the existing scan on retry without creating another scan", async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ version: "2.1.0", runs: [] }))
    const output = makeOutput()
    expect(await handleScan(["--scan-id", "s-123", "--sarif", "report.sarif"], output)).toBe(0)
    const client = await createClient()
    expect(client.request).toHaveBeenCalledTimes(1)
    expect(client.request).toHaveBeenCalledWith(
      "POST",
      "/scans/s-123/artifacts/sarif?workspaceId=ws-current",
      expect.any(Object)
    )
  })

  it("returns the created scan ID and a safe retry command when import fails", async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ version: "2.1.0", runs: [] }))
    const client = await createClient()
    vi.mocked(client.request)
      .mockResolvedValueOnce({ id: "s-123" })
      .mockRejectedValueOnce(new Error("unavailable"))
    const output = makeOutput()
    expect(await handleScan(["--target", "t-1", "--sarif", "report.sarif"], output)).toBe(2)
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining("--scan-id s-123"))
    expect(client.request).toHaveBeenCalledTimes(2)
  })
})
