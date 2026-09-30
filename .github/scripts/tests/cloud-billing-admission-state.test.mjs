import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

const parser = ".github/scripts/parse-cloud-billing-admission.mjs"
const reader = ".github/scripts/read-cloud-billing-admission.sh"
const entries = (polar = "public", razorpay = polar, allowlist = "") => [
  { name: "POLAR_BILLING_ADMISSION", value: polar },
  { name: "RAZORPAY_BILLING_ADMISSION", value: razorpay },
  { name: "BILLING_CANARY_WORKSPACE_IDS", value: allowlist },
]

function parse(value) {
  return spawnSync("node", [parser], { input: JSON.stringify(value), encoding: "utf8" })
}

test("preserves a valid live joint mode and canary allowlist", () => {
  assert.equal(
    parse(entries("canary", "canary", "workspace_one,workspace-two")).stdout,
    "POLAR_BILLING_ADMISSION=canary\n" +
      "RAZORPAY_BILLING_ADMISSION=canary\n" +
      "BILLING_CANARY_WORKSPACE_IDS=workspace_one,workspace-two\n"
  )
  assert.equal(parse(entries("off")).status, 0)
  assert.equal(parse(entries("public")).status, 0)
})

test("fails closed on incomplete, divergent or injectable live admission", () => {
  for (const invalid of [
    entries("public", "off"),
    entries("canary", "canary", ""),
    entries("public", "public", "workspace-one"),
    entries("public").slice(0, 2),
    [...entries("public"), { name: "POLAR_BILLING_ADMISSION", value: "off" }],
    entries("canary", "canary", "workspace-one\nOTHER_VAR=1"),
    [{ name: "POLAR_BILLING_ADMISSION", secretRef: "secret" }, ...entries("public").slice(1)],
  ]) {
    const result = parse(invalid)
    assert.notEqual(result.status, 0, JSON.stringify(invalid))
    assert.equal(result.stdout, "")
  }
})

test("reads only the one 100-percent traffic revision before a deployment", () => {
  const directory = mkdtempSync(join(tmpdir(), "cloud-billing-state-"))
  const fakeAz = join(directory, "az")
  writeFileSync(
    fakeAz,
    `#!/bin/sh
case "$*" in
  *"containerapp show"*) printf '%s\\n' "\${MOCK_TRAFFIC_REVISIONS}" ;;
  *"containerapp revision show"*) printf '%s\\n' "\${MOCK_REVISION_ENV}" ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 }
  )
  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    AZURE_RESOURCE_GROUP: "test-group",
    AZURE_APP_CONTAINER_APP_NAME: "test-app",
    MOCK_TRAFFIC_REVISIONS: "test-revision",
    MOCK_REVISION_ENV: JSON.stringify(entries("public")),
  }
  const valid = spawnSync("bash", [reader], { env, encoding: "utf8" })
  assert.equal(valid.status, 0, valid.stderr)
  assert.match(valid.stdout, /POLAR_BILLING_ADMISSION=public/)

  for (const revisions of ["", "test-revision\nsecond-revision"]) {
    const result = spawnSync("bash", [reader], {
      env: { ...env, MOCK_TRAFFIC_REVISIONS: revisions },
      encoding: "utf8",
    })
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, "")
  }
})
