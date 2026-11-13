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
