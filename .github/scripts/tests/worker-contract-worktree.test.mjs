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

test("worker contract verification tests the merged app even after a squash", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "worker-contract-squash-"))
  const app = path.join(directory, "app")
  const engine = path.join(directory, "engine")
  mkdirSync(app)
  mkdirSync(path.join(engine, "scripts"), { recursive: true })
  const git = (...args) => execFileSync("git", args, { cwd: app, encoding: "utf8" })
  const commit = (message) => {
    git("add", "source.txt")
    git("-c", "user.name=Review Test", "-c", "user.email=review@example.invalid", "commit", "-qm", message)
  }
  try {
    git("init", "-q", "-b", "main")
    writeFileSync(path.join(app, "source.txt"), "base\n")
    commit("base")
    git("switch", "-qc", "reviewed")
    writeFileSync(path.join(app, "source.txt"), "reviewed branch\n")
    commit("reviewed")
    const reviewed = git("rev-parse", "HEAD").trim()
    git("switch", "-q", "main")
    writeFileSync(path.join(app, "source.txt"), "squash merge\n")
    commit("squashed")
    writeFileSync(path.join(engine, ".lyrashield-worker-pin"), `${reviewed}\n`)
    writeFileSync(path.join(engine, "scripts/worker-contract-tests.txt"), "missing-test.ts\n")

    assert.equal(spawnSync("git", ["merge-base", "--is-ancestor", reviewed, "HEAD"], { cwd: app }).status, 1)
    const result = spawnSync(
      "bash",
      [path.resolve(".github/scripts/verify-engine-worker-contract.sh"), engine, app],
      { encoding: "utf8" }
    )
    assert.equal(result.status, 2)
    assert.match(result.stderr, /Missing worker contract test: missing-test\.ts/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("engine-worker contract is not skipped on app main or pull requests", () => {
  const workflow = readFileSync(path.resolve(".github/workflows/ci.yml"), "utf8")
  const job = workflow.split("  engine-worker-contract:")[1]?.split("  deploy-marketing:")[0]
  assert.ok(job)
  assert.match(job, /name: Pinned Engine \/ Worker Contract/)
  assert.doesNotMatch(job, /^    if:/m)
})
