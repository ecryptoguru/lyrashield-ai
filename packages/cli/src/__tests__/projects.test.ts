import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { exec } from "node:child_process"
import { promisify } from "node:util"
import { parseRepoIdentifier } from "@lyrashield/sdk"
import { findTargetByRepository, resolveRepoFromPath } from "../projects.js"

const execAsync = promisify(exec)

async function initGitRepo(dir: string, remote: string): Promise<void> {
  await execAsync("git init", { cwd: dir })
  await execAsync(`git remote add origin ${remote}`, { cwd: dir })
}

describe("resolveRepoFromPath", () => {
  let repoDir: string

  beforeAll(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), "lyrashield-project-test-"))
    await initGitRepo(repoDir, "https://github.com/ecryptoguru/lyrashield-ai.git")
  })

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true })
  })

  it("detects the origin remote from a git repo and parses it", async () => {
    const result = await resolveRepoFromPath(repoDir)
    expect(result.repo?.repoFullName).toBe("ecryptoguru/lyrashield-ai")
    expect(result.repo?.repoProvider).toBe("github")
  })

  it("returns undefined when there is no git repo", async () => {
    const emptyDir = await mkdtemp(path.join(tmpdir(), "lyrashield-empty-test-"))
    const result = await resolveRepoFromPath(emptyDir)
    expect(result.repo).toBeUndefined()
    await rm(emptyDir, { recursive: true, force: true })
  })
})

describe("parseRepoIdentifier integration", () => {
  it("matches what git detection returns for an HTTPS URL", () => {
    const repo = parseRepoIdentifier("https://github.com/ecryptoguru/lyrashield-ai.git")
    expect(repo).toEqual({
      repoProvider: "github",
      repoOwner: "ecryptoguru",
      repoName: "lyrashield-ai",
      repoFullName: "ecryptoguru/lyrashield-ai",
    })
  })

  it("handles an SSH URL", () => {
    const repo = parseRepoIdentifier("git@github.com:ecryptoguru/lyrashield-ai.git")
    expect(repo?.repoFullName).toBe("ecryptoguru/lyrashield-ai")
  })

  it("passes through owner/repo", () => {
    const repo = parseRepoIdentifier("ecryptoguru/lyrashield-ai")
    expect(repo?.repoFullName).toBe("ecryptoguru/lyrashield-ai")
  })

  it("rejects non-repo URLs", () => {
    expect(parseRepoIdentifier("not-a-repo")).toBeUndefined()
    expect(parseRepoIdentifier("https://github.com/ecryptoguru")).toBeUndefined()
    expect(parseRepoIdentifier("a/b/c")).toBeUndefined()
  })
})

describe("findTargetByRepository", () => {
  const repo = parseRepoIdentifier("ecryptoguru/lyrashield-ai")!

  it("reuses an API target even though the list payload omits repoProvider", async () => {
    const request = vi.fn().mockResolvedValue({
      items: [{ id: "t-1", name: "LyraShield", repoFullName: repo.repoFullName }],
    })
    const target = await findTargetByRepository({ request } as never, "ws-1", repo)

    expect(target).toMatchObject({ id: "t-1", name: "LyraShield" })
  })

  it("searches subsequent pages before deciding a repository is missing", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ items: [], nextCursor: "cursor-1" })
      .mockResolvedValueOnce({
        items: [{ id: "t-2", name: "LyraShield", repoFullName: repo.repoFullName }],
        nextCursor: null,
      })
    const target = await findTargetByRepository({ request } as never, "ws-1", repo)

    expect(target).toMatchObject({ id: "t-2" })
    expect(request).toHaveBeenNthCalledWith(2, "GET", "/targets?workspaceId=ws-1&cursor=cursor-1")
  })
})
