import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"

const workflow = readFileSync(".github/workflows/deploy-azure.yml", "utf8")
const start = workflow.indexOf("        run: |") + "        run: |\n".length
const end = workflow.indexOf("\n  build:", start)
const script = workflow
  .slice(start, end)
  .split("\n")
  .map((line) => line.replace(/^ {10}/, ""))
  .join("\n")
const source = "a".repeat(40)
function dispatch(t, attempt, originalStatus, currentMain = source) {
  const directory = mkdtempSync(path.join(tmpdir(), "ls-cutover-dispatch-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const gh = path.join(directory, "gh")
  writeFileSync(
    gh,
    `#!${process.execPath}\nconsole.log(process.argv.join(' ').includes('/attempts/1/jobs')?${JSON.stringify(originalStatus)}:${JSON.stringify(currentMain)})`
  )
  chmodSync(gh, 0o755)
  const output = path.join(directory, "output")
  writeFileSync(output, "")
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      SOURCE_SHA: source,
      CONFIRMATION: `webhook-cutover:${source}`,
      WEBHOOK_CLAIMS_CUTOVER: "true",
      GITHUB_RUN_ATTEMPT: String(attempt),
      GITHUB_RUN_ID: "123",
      GITHUB_REPOSITORY: "example/repository",
      GITHUB_OUTPUT: output,
    },
  })
  return { ...result, output: readFileSync(output, "utf8") }
}
test("new dispatch must still select current main", (t) =>
  assert.notEqual(dispatch(t, 1, "success", "b".repeat(40)).status, 0))
test("same run preserves successfully validated original SHA after main advances but demands receipt proof", (t) => {
  const result = dispatch(t, 2, "success", "b".repeat(40))
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.output, /recovery_requires_receipt=true/)
})
test("rerun cannot turn rejected first dispatch into original-source authorization", (t) =>
  assert.notEqual(dispatch(t, 2, "failure", "b".repeat(40)).status, 0))

test("rerun at current main can recover a transient validation failure", (t) =>
  assert.equal(dispatch(t, 2, "failure").status, 0))
test("runtime rechecks advanced main even when failed-job rerun reused validator output false", (t) => {
  const runtime = readFileSync(".github/workflows/deploy-azure-runtime.yml", "utf8")
  const section = runtime.slice(
    runtime.indexOf("      - name: Verify existing owned receipt before original-source recovery"),
    runtime.indexOf("      # Read-only guard")
  )
  assert.match(section, /if: inputs.webhook_claims_cutover == true\n/)
  assert.doesNotMatch(section, /inputs.webhook_recovery_requires_receipt/)
  const body = section
    .slice(section.indexOf("        run: |\n") + "        run: |\n".length)
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n")
  const directory = mkdtempSync(path.join(tmpdir(), "ls-runtime-recovery-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(path.join(directory, "gh"), `#!/bin/sh\nprintf '%s\\n' '${"b".repeat(40)}'\n`)
  chmodSync(path.join(directory, "gh"), 0o755)
  writeFileSync(
    path.join(directory, "bash"),
    "#!/bin/sh\necho receipt-proof-required >&2\nexit 23\n"
  )
  chmodSync(path.join(directory, "bash"), 0o755)
  const result = spawnSync("/bin/bash", ["-c", body], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      DEPLOY_SHA: source,
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_REPOSITORY: "example/repository",
    },
  })
  assert.equal(result.status, 23)
  assert.match(result.stderr, /receipt-proof-required/)
})
