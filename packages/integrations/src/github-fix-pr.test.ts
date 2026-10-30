import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock("./github", () => ({ getInstallationToken: vi.fn().mockResolvedValue("test-token") }))
vi.mock("./github-http", () => ({
  githubFetch: mocks.fetch,
  GITHUB_API_BASE: "https://api.github.com",
  GITHUB_HEADERS: {},
}))
import { inspectFixPrRemote } from "./github-fix-pr"
const marker = "<!-- lyrashield-fix:identity -->"
const pull = {
  number: 42,
  html_url: "https://github.com/owner/repo/pull/42",
  state: "open",
  body: marker,
  merged_at: null,
  head: { ref: "fix/identity", repo: { full_name: "owner/repo" } },
  base: { repo: { full_name: "owner/repo" } },
}
const inspect = () => inspectFixPrRemote(1, "owner", "repo", "fix/identity", marker)
describe("GitHub deterministic PR recovery", () => {
  beforeEach(() => vi.resetAllMocks())
  it("finds an open PR by exact head and server identity", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json([pull]))
    expect(await inspect()).toEqual({
      branchExists: true,
      pullRequest: { number: 42, url: pull.html_url, status: "open" },
    })
  })
  it.each([null, "2026-10-30T00:00:00Z"])("retains terminal PR state %s", async (merged_at) => {
    mocks.fetch.mockResolvedValueOnce(Response.json([{ ...pull, state: "closed", merged_at }]))
    expect((await inspect()).pullRequest?.status).toBe(merged_at ? "merged" : "closed")
  })
  it.each([
    { body: "unrelated" },
    { html_url: "https://evil.invalid/" },
    { head: { ref: "fix/other", repo: { full_name: "owner/repo" } } },
  ])("refuses mismatched remote identity %j", async (change) => {
    mocks.fetch.mockResolvedValueOnce(Response.json([{ ...pull, ...change }]))
    await expect(inspect()).rejects.toThrow()
  })
  it("does not turn a provider failure into confirmed absence", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
    await expect(inspect()).rejects.toThrow()
  })
  it("detects a partial branch when no PR was created", async () => {
    mocks.fetch
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({ ref: "refs/heads/fix/identity" }))
    expect(await inspect()).toEqual({ branchExists: true, pullRequest: null })
  })
  it("confirms absence only after successful list and branch 404", async () => {
    mocks.fetch
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
    expect(await inspect()).toEqual({ branchExists: false, pullRequest: null })
  })
  it("refuses multiple matching PRs", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json([pull, { ...pull, number: 43 }]))
    await expect(inspect()).rejects.toThrow()
  })
})
