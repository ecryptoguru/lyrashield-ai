import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { randomBytes } from "node:crypto"
import { checkIssuerHealth, verifyHealthSignature } from "../qualification-issuer-health.mjs"

const fixture = JSON.parse(
  // Fixed public signature fixture, with no private key or credential.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  readFileSync(new URL("./fixtures/qualification-key-health.json", import.meta.url), "utf8")
)
const { parse } = createRequire(
  new URL("../../../packages/agent-plugin/package.json", import.meta.url)
)("yaml")

test("actual managed RSA signature verifies only exact bytes, pinned key version and algorithm", () => {
  verifyHealthSignature(fixture.raw, fixture.result)
  assert.equal(JSON.parse(fixture.raw).productionQualification, false)
  assert.throws(() => verifyHealthSignature(fixture.raw + " ", fixture.result))
  for (const field of ["keyId", "algorithm", "signature"])
    assert.throws(() =>
      verifyHealthSignature(fixture.raw, { ...fixture.result, [field]: "foreign" })
    )
  assert.throws(() => verifyHealthSignature(fixture.raw, { ...fixture.result, qualified: true }))
  assert.throws(() => verifyHealthSignature("x".repeat(4097), fixture.result))
})

test("unverified identity never exchanges credentials or signs", async () => {
  const calls = []
  await assert.rejects(
    checkIssuerHealth({
      readIdentity: async () => {
        throw new Error("identity unavailable")
      },
      run: (args) => calls.push(args),
    })
  )
  assert.deepEqual(calls, [])
})

test("signing failures log out and cannot return a qualified receipt", async () => {
  const token = randomBytes(24).toString("base64url")
  for (const failure of ["login", "keyvault", "malformed-signature"]) {
    const calls = []
    await assert.rejects(
      checkIssuerHealth({
        readIdentity: async () => ({
          token,
          identity: { source: "a".repeat(40), owner: "42:1" },
        }),
        run: (args) => {
          calls.push(args)
          if (args[0] === failure) throw new Error("unavailable")
          if (args[0] === "keyvault") return fixture.result
          return null
        },
      })
    )
    assert.deepEqual(calls.at(-1), ["logout"])
    const signing = calls.find((args) => args[0] === "keyvault")
    if (signing) {
      assert.equal(signing[signing.indexOf("--id") + 1], fixture.result.keyId)
      assert.equal(signing[signing.indexOf("--algorithm") + 1], "RS256")
    }
  }
})

test("isolated issuer verifies optional publication before fixed health signing, with no deployment authority", () => {
  const issuer = parse(readFileSync(".github/workflows/issue-runtime-qualification.yml", "utf8"))
  const caller = parse(readFileSync(".github/workflows/qualify-runtime-issuer.yml", "utf8"))
  const input = "fresh_sandbox_publication"
  const inventory = "fresh_sandbox_inventory"
  const fleet = "runtime_fleet_evidence"
  assert.deepEqual(Object.keys(issuer.on.workflow_call.inputs), [
    input,
    inventory,
    fleet,
    "prepared_fleet",
  ])
  assert.deepEqual(Object.keys(caller.on.workflow_dispatch.inputs), [input, inventory])
  for (const definition of [
    issuer.on.workflow_call.inputs[input],
    caller.on.workflow_dispatch.inputs[input],
    issuer.on.workflow_call.inputs[inventory],
    caller.on.workflow_dispatch.inputs[inventory],
    issuer.on.workflow_call.inputs[fleet],
    issuer.on.workflow_call.inputs.prepared_fleet,
  ]) {
    assert.equal(definition.type, "string")
    assert.equal(definition.required, false)
    assert.equal(definition.default, "")
  }
  assert.equal(caller.jobs.signer.uses, "./.github/workflows/issue-runtime-qualification.yml")
  const job = issuer.jobs["verify-signing-boundary"]
  assert.equal(job.environment, "release-qualification")
  assert.equal(job["runs-on"], "ubuntu-24.04")
  assert.equal(job["timeout-minutes"], 10)
  assert.deepEqual(job.permissions, {
    contents: "read",
    actions: "read",
    "id-token": "write",
    packages: "read",
  })
  for (const condition of ["1286618458", "116722580", "refs/heads/main", "workflow_dispatch"])
    assert.ok(job.if.includes(condition))
  assert.ok(job.if.includes("github.event_name == 'push'"))
  assert.equal(job.steps[0].with.ref, "${{ github.sha }}")
  assert.equal(job.steps[0].with["persist-credentials"], false)
  assert.deepEqual(caller.jobs.signer.with, {
    [input]: "${{ inputs.fresh_sandbox_publication }}",
    [inventory]: "${{ inputs.fresh_sandbox_inventory }}",
  })
  const commands = job.steps.filter((step) => step.run)
  assert.equal(commands.length, 5)
  assert.equal(commands[0].run, "bash .github/scripts/prepare-qualification-verifier.sh")
  assert.equal(
    commands[0].if,
    "inputs.fresh_sandbox_publication != '' || inputs.fresh_sandbox_inventory != '' || inputs.runtime_fleet_evidence != ''"
  )
  assert.equal(commands[1].run, "node .github/scripts/issue-sandbox-publication.mjs")
  assert.equal(commands[1].if, "inputs.fresh_sandbox_publication != ''")
  assert.equal(commands[1].env.FRESH_SANDBOX_PUBLICATION, "${{ inputs.fresh_sandbox_publication }}")
  assert.equal(commands[2].run, "node .github/scripts/issue-sandbox-inventory.mjs")
  assert.equal(commands[2].if, "inputs.fresh_sandbox_inventory != ''")
  assert.equal(commands[2].env.FRESH_SANDBOX_INVENTORY, "${{ inputs.fresh_sandbox_inventory }}")
  assert.equal(commands[3].run, "node .github/scripts/issue-runtime-fleet-qualification.mjs")
  assert.equal(commands[3].if, "inputs.runtime_fleet_evidence != ''")
  assert.equal(commands[3].env.RUNTIME_FLEET_EVIDENCE, "${{ inputs.runtime_fleet_evidence }}")
  assert.equal(commands[4].run, "node .github/scripts/qualification-issuer-health.mjs")
  const artifact = job.steps.find((step) => step.with?.path === "sandbox-publication-record.json")
  assert.equal(artifact.if, "inputs.fresh_sandbox_publication != ''")
  assert.equal(artifact.with["if-no-files-found"], "error")
  const inventoryArtifact = job.steps.find(
    (step) => step.with?.path === "sandbox-inventory-record.json"
  )
  assert.equal(inventoryArtifact.if, "inputs.fresh_sandbox_inventory != ''")
  assert.equal(inventoryArtifact.with["if-no-files-found"], "error")
  const fleetArtifact = job.steps.find(
    (step) =>
      step.with?.name ===
      "runtime-fleet-qualification-${{ github.run_id }}-${{ github.run_attempt }}"
  )
  assert.ok(fleetArtifact)
  assert.equal(fleetArtifact.if, "inputs.runtime_fleet_evidence != ''")
  assert.equal(fleetArtifact.with["if-no-files-found"], "error")
  assert.deepEqual(Object.keys(job.outputs), [
    "runtime_fleet_qualification",
    "runtime_fleet_record_sha256",
  ])
  assert.equal(
    issuer.on.workflow_call.outputs.runtime_fleet_qualification.value,
    "${{ jobs.verify-signing-boundary.outputs.runtime_fleet_qualification }}"
  )
  assert.doesNotMatch(JSON.stringify(issuer), /secrets\.|deploy-azure|qualified_release_digest/)
})
