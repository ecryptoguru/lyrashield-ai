import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, symlinkSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
function execute(t, receipt, linked = false) {
  const directory = mkdtempSync(join(tmpdir(), "v26-preflight-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const write = (name, body) => {
    const file = join(directory, name)
    // Only fixed workflow sources or this test’s disposable directory are accessed.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(file, body)
    // Only fixed workflow sources or this test’s disposable directory are accessed.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    chmodSync(file, 0o755)
  }
  write("worker-runtime.conf", `LYRASHIELD_WORKER_IMAGE=fixture@sha256:${"a".repeat(64)}\n`)
  if (receipt) {
    write("v26-cutover.json", JSON.stringify(receipt))
    if (linked) {
      write("linked-receipt", JSON.stringify(receipt))
      rmSync(join(directory, "v26-cutover.json"))
      // Only fixed workflow sources or this test’s disposable directory are accessed.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      symlinkSync(join(directory, "linked-receipt"), join(directory, "v26-cutover.json"))
    }
  }
  write("stat", "#!/bin/sh\nprintf '0:600\\n'\n")
  write("timeout", '#!/bin/sh\nshift 2\nexec "$@"\n')
  write(
    "docker",
    `#!${process.execPath}\nconst {spawnSync}=require("node:child_process");const args=process.argv.slice(2);const index=args.indexOf("-e");const result=spawnSync(process.execPath,["-e",...args.slice(index+1)],{encoding:"utf8"});process.stdout.write(result.stdout);process.exit(result.status);`
  )
  write(
    "az",
    `#!${process.execPath}\nconst {spawnSync}=require("node:child_process");const args=process.argv.slice(2);const script=args[args.indexOf("--scripts")+1].replaceAll("/var/lib/lyrashield",process.env.V26_GATE_TEST_DIRECTORY).replaceAll("/etc/lyrashield",process.env.V26_GATE_TEST_DIRECTORY);const result=spawnSync("sh",["-c",script],{encoding:"utf8",env:process.env});process.stdout.write(result.stdout);process.exit(result.status);`
  )
  return spawnSync("bash", [".github/scripts/assert-no-held-v26.sh"], {
    encoding: "utf8",
    env: {
      ...process.env,
      RG: "fixture",
      WORKER_VM_NAME: "fixture-worker",
      V26_GATE_TEST_DIRECTORY: directory,
      PATH: `${directory}:${process.env.PATH}`,
    },
    timeout: 20000,
  })
}
test("actual preflight shell permits a fresh or completed v26 release and rejects held foreign malformed or linked receipts", (t) => {
  for (const receipt of [null, { kind: "v26-accounting-cutover", phase: "COMPLETE" }])
    assert.equal(execute(t, receipt).status, 0)
  for (const receipt of [
    { kind: "v26-accounting-cutover", phase: "MIGRATED" },
    { kind: "webhook-claims-cutover", phase: "COMPLETE" },
    {},
  ]) {
    const result = execute(t, receipt)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Automatic retry is blocked/)
    assert.doesNotMatch(result.stderr, /fixture@|linked-receipt/)
  }
  assert.notEqual(execute(t, { kind: "v26-accounting-cutover", phase: "COMPLETE" }, true).status, 0)
})
test("workflow gates v26 before webhook retry classification and retains separate migration semantics", () => {
  // Only fixed workflow sources or this test’s disposable directory are accessed.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const parent = readFileSync(new URL("../../workflows/deploy-azure.yml", import.meta.url), "utf8")
  // Only fixed workflow sources or this test’s disposable directory are accessed.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const runtime = readFileSync(
    new URL("../../workflows/deploy-azure-runtime.yml", import.meta.url),
    "utf8"
  )
  assert.ok(
    parent.indexOf("Block automatic retry of incomplete v26 maintenance") <
      parent.indexOf("Classify webhook baseline before image build")
  )
  assert.ok(
    runtime.indexOf("Recheck v26 maintenance before any production mutation") <
      runtime.indexOf("Revalidate retry state for an automatic first cutover")
  )
  assert.match(
    runtime,
    /--expect-mode "\$\{\{ inputs.webhook_claims_cutover == true && 'first-cutover' \|\| 'compatible' \}\}"/
  )
  const migration = runtime.slice(
    runtime.indexOf("      - name: Run database migrations"),
    runtime.indexOf("      - name: Grant observed runtime principals")
  )
  assert.ok(
    migration.indexOf("v26-cutover.mjs before-migrate") <
      migration.indexOf("run-database-migrations")
  )
  const rollback = runtime.slice(
    runtime.indexOf("      - name: Roll back production traffic"),
    runtime.indexOf("      - name: Restore prior ingress")
  )
  assert.match(rollback, /env\.V26_CUTOVER != 'true'/)
})
