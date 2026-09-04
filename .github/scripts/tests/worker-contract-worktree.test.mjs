import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import assert from "node:assert/strict"
import { test } from "node:test"

test("worker contract verification refuses a dirty checkout without overwriting it", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "worker-contract-worktree-"))
  const app = path.join(directory, "app")
  const engine = path.join(directory, "engine")
  mkdirSync(app)
  mkdirSync(path.join(engine, "scripts"), { recursive: true })
  const git = (...args) => execFileSync("git", args, { cwd: app, encoding: "utf8" })
  try {
    git("init", "-q")
    writeFileSync(path.join(app, "source.txt"), "committed\n")
    git("add", "source.txt")
    git(
      "-c",
      "user.name=Review Test",
      "-c",
      "user.email=review@example.invalid",
      "commit",
      "-qm",
      "fixture"
    )
    writeFileSync(path.join(engine, ".lyrashield-worker-pin"), git("rev-parse", "HEAD"))
    writeFileSync(path.join(engine, "scripts/worker-contract-tests.txt"), "missing-test.ts\n")
    writeFileSync(path.join(app, "source.txt"), "staged change\n")
    git("add", "source.txt")
    writeFileSync(path.join(app, "source.txt"), "unstaged change\n")
    const before = git("status", "--porcelain")
    const result = spawnSync(
      "bash",
      [path.resolve(".github/scripts/verify-engine-worker-contract.sh"), engine, app],
      { encoding: "utf8" }
    )
    assert.equal(readFileSync(path.join(app, "source.txt"), "utf8"), "unstaged change\n")
    assert.equal(git("show", ":source.txt"), "staged change\n")
    assert.equal(git("status", "--porcelain"), before)
    assert.equal(result.status, 2)
    assert.match(result.stderr, /tracked modifications/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
