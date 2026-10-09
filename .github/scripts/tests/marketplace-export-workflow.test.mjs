import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

const workflowPath = path.join(process.cwd(), "docs/marketplace/.github/workflows/validate.yml")
const workflow = readFileSync(workflowPath, "utf8")
const stepStart = workflow.indexOf("      - name: Detect Zed extension changes\n")
assert.notEqual(stepStart, -1, "the exported validation workflow must gate the Zed build")
const runMarker = "        run: |\n"
const runStart = workflow.indexOf(runMarker, stepStart)
assert.notEqual(runStart, -1, "the Zed build gate must remain an inline shell step")
const scriptStart = runStart + runMarker.length
const nextStep = workflow.indexOf("\n      - name: ", scriptStart)
assert.notEqual(nextStep, -1, "the Zed build gate must be followed by another workflow step")
const detectorScript = workflow
  .slice(scriptStart, nextStep)
  .split("\n")
  .map((line) => line.replace(/^ {10}/, ""))
  .join("\n")

function git(directory, ...args) {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim()
}

function createRepository(t, name) {
  const directory = mkdtempSync(path.join(tmpdir(), `lyra-${name}-`))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  git(directory, "init", "--quiet")
  git(directory, "config", "user.name", "LyraShield Test")
  git(directory, "config", "user.email", "lyrashield-test@example.invalid")
  writeFileSync(path.join(directory, "README.md"), "base\n")
  git(directory, "add", "README.md")
  git(directory, "commit", "--quiet", "-m", "base")
  return directory
}

function runDetector(directory, baseSha) {
  const outputPath = path.join(directory, "github-output")
  writeFileSync(outputPath, "")
  const result = spawnSync("bash", ["-e", "-c", detectorScript], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      BASE_SHA: baseSha,
      BEFORE_SHA: "",
      GITHUB_OUTPUT: outputPath,
    },
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return readFileSync(outputPath, "utf8")
}

test("runs the Zed build when the merge base cannot be determined", (t) => {
  const directory = createRepository(t, "zed-no-merge-base")
  const baseSha = git(directory, "rev-parse", "HEAD")
  git(directory, "checkout", "--quiet", "--orphan", "unrelated")
  git(directory, "rm", "--quiet", "-rf", ".")
  writeFileSync(path.join(directory, "unrelated.txt"), "unrelated history\n")
  git(directory, "add", "unrelated.txt")
  git(directory, "commit", "--quiet", "-m", "unrelated root")

  assert.equal(runDetector(directory, baseSha), "changed=true\n")
})

test("uses marketplace-root workflow paths to select the Zed build", (t) => {
  const directory = createRepository(t, "zed-root-workflow")
  const baseSha = git(directory, "rev-parse", "HEAD")
  const workflowDirectory = path.join(directory, ".github/workflows")
  mkdirSync(workflowDirectory, { recursive: true })
  writeFileSync(path.join(workflowDirectory, "validate.yml"), "changed workflow\n")
  git(directory, "add", ".github/workflows/validate.yml")
  git(directory, "commit", "--quiet", "-m", "change exported workflow")

  assert.equal(runDetector(directory, baseSha), "changed=true\n")
})

test("skips only when a valid merge base has no relevant changes", (t) => {
  const directory = createRepository(t, "zed-unrelated-change")
  const baseSha = git(directory, "rev-parse", "HEAD")
  writeFileSync(path.join(directory, "README.md"), "unrelated documentation change\n")
  git(directory, "add", "README.md")
  git(directory, "commit", "--quiet", "-m", "change unrelated documentation")

  assert.equal(runDetector(directory, baseSha), "changed=false\n")
})
