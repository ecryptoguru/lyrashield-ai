import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"

const workflow = readFileSync(".github/workflows/deploy-azure.yml", "utf8")
const source = "a".repeat(40)
function dispatch(
  t,
  attempt,
  originalStatus,
  currentMain = source,
  workflowRef = "refs/heads/main"
) {
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
  const result = spawnSync("bash", [".github/scripts/validate-webhook-deploy-dispatch.sh"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      SOURCE_SHA: source,
      GITHUB_REF: workflowRef,
      GITHUB_REPOSITORY: "example/repository",
    },
  })
  return { ...result, output: readFileSync(output, "utf8") }
}
test("dispatch uses the trusted main validator and rejects caller refs before release jobs", () => {
  const job = workflow.slice(
    workflow.indexOf("  validate-manual-production-dispatch:"),
    workflow.indexOf("\n  preflight-compatible-baseline:")
  )
  assert.match(
    job,
    /if: github\.event_name != 'workflow_dispatch' \|\| github\.ref == 'refs\/heads\/main'/
  )
  const checkoutAt = job.indexOf("name: Checkout trusted main dispatch validator")
  const validatorAt = job.indexOf(
    "run: bash \.github\/scripts\/validate-webhook-deploy-dispatch\.sh"
  )
  assert.ok(checkoutAt >= 0 && checkoutAt < validatorAt)
  const checkout = job.slice(checkoutAt, validatorAt)
  assert.match(checkout, /uses: actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/)
  assert.match(checkout, /ref: refs\/heads\/main/)
  assert.match(checkout, /persist-credentials: false/)
})
test("new dispatch must still select current main", (t) =>
  assert.notEqual(dispatch(t, 1, "success", "b".repeat(40)).status, 0))
test("dispatch helper rejects an untrusted caller branch", (t) =>
  assert.notEqual(dispatch(t, 1, "success", source, "refs/heads/feature/untrusted").status, 0))
test("manual reruns cannot deploy an older source after main advances", (t) => {
  const result = dispatch(t, 2, "success", "b".repeat(40))
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /may only target current main/)
})
test("rerun cannot turn rejected first dispatch into original-source authorization", (t) =>
  assert.notEqual(dispatch(t, 2, "failure", "b".repeat(40)).status, 0))

test("current-main manual rerun remains eligible", (t) =>
  assert.equal(dispatch(t, 2, "failure").status, 0))
test("cutover retry requires a proven receipt or reclassifies only on current main", (t) => {
  const runtime = readFileSync(".github/workflows/deploy-azure-runtime.yml", "utf8")
  const section = runtime.slice(
    runtime.indexOf("      - name: Revalidate retry state for an automatic first cutover"),
    runtime.indexOf("      # A retried first cutover may reuse")
  )
  assert.match(
    section,
    /if: inputs\.held_recovery != true && inputs\.webhook_claims_cutover == true && github\.run_attempt > 1/
  )
  assert.match(section, /recovery-probe/)
  const body = section
    .slice(section.indexOf("        run: |\n") + "        run: |\n".length)
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n")
  const run = (t, currentMain, probeResult) => {
    const directory = mkdtempSync(path.join(tmpdir(), "ls-runtime-recovery-"))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    writeFileSync(path.join(directory, "gh"), `#!/bin/sh\nprintf '%s\\n' '${currentMain}'\n`)
    chmodSync(path.join(directory, "gh"), 0o755)
    writeFileSync(
      path.join(directory, "bash"),
      `#!/bin/sh\nprintf '%s\\n' '${probeResult.output ?? ""}'\nexit ${probeResult.status ?? 0}\n`
    )
    chmodSync(path.join(directory, "bash"), 0o755)
    const output = path.join(directory, "github-output")
    writeFileSync(output, "")
    const result = spawnSync("/bin/bash", ["-c", body], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        DEPLOY_SHA: source,
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_REPOSITORY: "example/repository",
        GITHUB_OUTPUT: output,
      },
    })
    return { ...result, output: readFileSync(output, "utf8") }
  }
  const absent = run(t, source, { output: "WEBHOOK_RECOVERY_RECEIPT_ABSENT" })
  assert.equal(absent.status, 0, absent.stderr)
  assert.match(absent.output, /receipt=absent/)

  const advancedWithoutReceipt = run(t, "b".repeat(40), {
    output: "WEBHOOK_RECOVERY_RECEIPT_ABSENT",
  })
  assert.notEqual(advancedWithoutReceipt.status, 0)
  assert.match(advancedWithoutReceipt.stdout, /requires its owned cutover receipt/)

  for (const currentMain of [source, "b".repeat(40)]) {
    const present = run(t, currentMain, { output: "WEBHOOK_RECOVERY_RECEIPT_VERIFIED" })
    assert.equal(present.status, 0, present.stderr)
    assert.match(present.output, /receipt=present/)
  }

  for (const output of [
    "WEBHOOK_RECOVERY_RECEIPT_VERIFIED\nWEBHOOK_RECOVERY_RECEIPT_ABSENT",
    "WEBHOOK_RECOVERY_RECEIPT_VERIFIED\nWEBHOOK_RECOVERY_RECEIPT_VERIFIED",
  ]) {
    const ambiguous = run(t, source, { output })
    assert.notEqual(ambiguous.status, 0)
    assert.equal(ambiguous.output, "")
  }

  const probeFailure = run(t, source, { output: "", status: 23 })
  assert.equal(probeFailure.status, 23)
  assert.doesNotMatch(probeFailure.output, /receipt=/)
})
