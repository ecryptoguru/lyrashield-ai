import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import assert from "node:assert/strict"
import { test } from "node:test"

/* eslint-disable security/detect-non-literal-fs-filename -- Test paths are confined to fresh temporary directories. */
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
    git(
      "-c",
      "user.name=Review Test",
      "-c",
      "user.email=review@example.invalid",
      "commit",
      "-qm",
      message
    )
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

    assert.equal(
      spawnSync("git", ["merge-base", "--is-ancestor", reviewed, "HEAD"], { cwd: app }).status,
      1
    )
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

test("worker contract rejects missing revision and scope flags even when help mentions them", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "worker-contract-flags-"))
  const app = path.join(directory, "app")
  const engine = path.join(directory, "engine")
  const bin = path.join(directory, "bin")
  mkdirSync(path.join(app, "apps/worker/src/engine/fixtures/run-json-1.1"), { recursive: true })
  mkdirSync(path.join(engine, "tests/fixtures"), { recursive: true })
  mkdirSync(path.join(engine, "scripts"), { recursive: true })
  mkdirSync(bin)
  const git = (...args) => execFileSync("git", args, { cwd: app, encoding: "utf8" })
  try {
    git("init", "-q")
    writeFileSync(path.join(app, "contract.test.ts"), "fixture\n")
    writeFileSync(
      path.join(app, "apps/worker/src/engine/fixtures/run-json-1.1/threat_model.json"),
      "{}"
    )
    writeFileSync(path.join(engine, "tests/fixtures/threat_model_writer_1_1.json"), "{}")
    git("add", ".")
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
    writeFileSync(path.join(engine, "scripts/worker-contract-tests.txt"), "contract.test.ts\n")
    writeFileSync(path.join(bin, "uv"), '#!/bin/sh\ncat "$CONTRACT_HELP"\n')
    chmodSync(path.join(bin, "uv"), 0o755)
    writeFileSync(path.join(bin, "corepack"), "#!/bin/sh\nexit 77\n")
    chmodSync(path.join(bin, "corepack"), 0o755)
    const flags = [
      "--non-interactive",
      "--run-name",
      "--target",
      "--scan-mode",
      "--instruction",
      "--max-budget-usd",
      "--runtime-budget-seconds",
      "--scope-mode",
      "--diff-base",
      "--diff-head",
      "--repository-revision",
      "--repository-branch",
      "--target-type",
    ]
    for (const missing of flags) {
      const help = flags
        .filter((flag) => flag !== missing)
        .map((flag) => `  ${flag} VALUE`)
        .join("\n")
      writeFileSync(path.join(directory, "help"), `${help}\n    Description mentions ${missing}.\n`)
      const result = spawnSync(
        "bash",
        [path.resolve(".github/scripts/verify-engine-worker-contract.sh"), engine, app],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            CONTRACT_HELP: path.join(directory, "help"),
          },
        }
      )
      assert.equal(result.status, 1, `expected ${missing} to fail`)
      assert.ok(result.stderr.includes(`missing worker CLI flag: ${missing}`))
    }
    const help = flags.map((flag) => {
      if (flag === "--non-interactive") return "  -n, --non-interactive"
      if (flag === "--scan-mode")
        return "  -m {quick,standard,deep}, --scan-mode {quick,standard,deep}"
      if (flag === "--max-budget-usd") return "  --max-budget USD, --max-budget-usd USD"
      return `  ${flag} VALUE`
    })
    writeFileSync(path.join(directory, "help"), `${help.join("\n")}\n`)
    const accepted = spawnSync(
      "bash",
      [path.resolve(".github/scripts/verify-engine-worker-contract.sh"), engine, app],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          CONTRACT_HELP: path.join(directory, "help"),
        },
      }
    )
    assert.equal(accepted.status, 77, "complete help should reach the dependency-install step")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
/* eslint-enable security/detect-non-literal-fs-filename */

test("required engine-worker context stays present and only unrelated paths get a success no-op", () => {
  const workflow = readFileSync(path.resolve(".github/workflows/ci.yml"), "utf8")
  // Start at the job declaration rather than the same output name in changes.
  const start = workflow.indexOf("\n  engine-worker-contract:\n")
  const nextJob = workflow.slice(start + 1).search(/\n  [a-z][a-z-]*:/)
  const end = nextJob < 0 ? -1 : start + 1 + nextJob
  const job = start < 0 ? "" : workflow.slice(start, end < 0 ? undefined : end)
  assert.ok(job)
  assert.match(job, /name: Pinned Engine \/ Worker Contract/)
  assert.match(job, /^    if: \$\{\{ always\(\) && !cancelled\(\) \}\}$/m)
  assert.match(job, /needs\.changes\.outputs\.engine-worker-contract == 'false'/)
  assert.match(job, /Changed-path classification did not succeed/)
  assert.match(job, /needs\.changes\.outputs\.engine-worker-contract != 'false'/)
  assert.match(
    workflow,
    /engine-worker-contract: \$\{\{ steps\.classify\.outputs\.engine-worker-contract \}\}/
  )
  assert.match(
    job,
    /if: \$\{\{ always\(\) && !cancelled\(\) && needs\.changes\.result != 'success' \}\}/
  )
  assert.match(job, /Checkout pinned engine/)
  assert.match(job, /Verify pinned engine-worker contract/)
  const contract = readFileSync(
    path.resolve(".github/scripts/verify-engine-worker-contract.sh"),
    "utf8"
  )
  assert.match(contract, /LYRASHIELD_ENGINE_CHECKOUT=/)
  assert.match(contract, /LYRASHIELD_ENGINE_PYTHON=/)
  assert.match(contract, /apps\/provider-gateway\/src\/engine-bridge\.integration\.test\.ts/)
})
