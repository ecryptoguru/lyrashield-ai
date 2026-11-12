import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { assertColdReleaseCaller } from "../assert-cold-release-caller.mjs"
import { coldHostScript, coldIdentity } from "../cold-release-azure.mjs"
import { verifyColdSandbox } from "../verify-cold-sandbox.mjs"
const require = createRequire(
  new URL("../../../packages/agent-plugin/package.json", import.meta.url)
)
const { parse } = require("yaml")
const env = {
  GITHUB_REPOSITORY: "ecryptoguru/lyrashield-ai",
  GITHUB_REPOSITORY_ID: "1286618458",
  GITHUB_REPOSITORY_OWNER_ID: "116722580",
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF: "refs/heads/main",
  GITHUB_WORKFLOW_REF:
    "ecryptoguru/lyrashield-ai/.github/workflows/release-production.yml@refs/heads/main",
  GITHUB_SHA: "a".repeat(40),
  DEPLOY_SHA: "a".repeat(40),
  GITHUB_RUN_ID: "42",
  GITHUB_RUN_ATTEMPT: "1",
  ENGINE_REVISION: "b".repeat(40),
  WORKER_IMAGE: "ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker",
  WORKER_DIGEST: "sha256:" + "c".repeat(64),
  COLD_SANDBOX_IMAGE: "ghcr.io/ecryptoguru/lyrashield-sandbox@sha256:" + "d".repeat(64),
  AZURE_APP_SECRET_KEY_VAULT_NAME: "lyrashieldprodappsecrets",
}
test("cold mutations require the exact protected main push caller and immutable tuple", () => {
  assertColdReleaseCaller(env)
  coldIdentity(env)
  for (const [field, value] of Object.entries({
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY_ID: "1",
    GITHUB_REF: "refs/pull/1/merge",
    GITHUB_WORKFLOW_REF: "other/workflow@refs/heads/main",
    DEPLOY_SHA: "e".repeat(40),
    COLD_SANDBOX_IMAGE: "sandbox:latest",
    WORKER_DIGEST: "latest",
  })) {
    assert.throws(() => coldIdentity({ ...env, [field]: value }))
  }
  assert.throws(() => coldIdentity({ ...env, GITHUB_SHA: undefined }))
})
test("every host operation is executable shell and contains no host GH or Node requirement", () => {
  const tuple = coldIdentity(env)
  for (const operation of ["prepare", "promote", "open", "contain", "proof", "finish"]) {
    const script = coldHostScript(
      operation,
      tuple,
      Buffer.from(JSON.stringify({ scanId: "fixture" })).toString("base64url")
    )
    assert.equal(spawnSync("sh", ["-n"], { input: script }).status, 0, operation)
    assert.doesNotMatch(script, /\/usr\/bin\/gh|(?:^|\n)\s*gh\s+attestation/)
    assert.match(script, /COLD_AZURE_OK/)
  }
  const finish = coldHostScript("finish", tuple, "e30")
  assert.ok(finish.indexOf("proof.get('result')!='MATCH'") < finish.indexOf("os.rename(path"))
  assert.match(finish, /proof\['workerDigest'\]!=image\.split\('@'\)\[1\]/)
  assert.throws(() => coldHostScript("proof", tuple, "unsafe $(x)"))
})
test("same-run release images and successful native checks are required before Azure runtime", () => {
  const release = parse(readFileSync(".github/workflows/release-production.yml", "utf8"))
  const deploy = parse(readFileSync(".github/workflows/deploy-azure.yml", "utf8"))
  const harness = parse(readFileSync(".github/workflows/verify-webhook-worker-image.yml", "utf8"))
  const runtime = parse(readFileSync(".github/workflows/deploy-azure-runtime.yml", "utf8"))
  assert.equal(release.jobs["deploy-azure"].with.cold_release, true)
  assert.ok(
    release.jobs.routing.steps.some((step) => step.run?.includes("qualify-release-source.mjs"))
  )
  assert.equal(
    deploy.jobs["verify-built-worker-image"].with.cold_release,
    "${{ inputs.cold_release }}"
  )
  assert.ok(deploy.jobs.deploy.needs.includes("verify-built-worker-image"))
  assert.match(
    deploy.jobs.deploy.with.cold_sandbox_image,
    /needs.verify-built-worker-image.outputs/
  )
  const native = harness.jobs["verify-worker-image"].steps
  for (const name of [
    "Reauthenticate immutable sandbox publication and native inventory",
    "Exercise actual installed engine SDK over native TCP and SIGKILL",
    "Exercise actual sandbox credentials and live network denial",
    "Verify cold database epoch failure in the exact running image",
  ]) {
    assert.equal(native.find((step) => step.name === name).if, "inputs.cold_release == true")
  }
  const steps = runtime.jobs.deploy.steps
  const index = (name) => steps.findIndex((step) => step.name === name)
  assert.ok(
    index("Stop admission and complete the native cold host barrier") <
      index("Run database migrations")
  )
  assert.ok(
    index("Install exact compatible cold worker while admission remains held") <
      index("Promote healthy candidate revisions")
  )
  assert.ok(
    index("Smoke production traffic") <
      index("Provisionally release only the owned cold admission hold")
  )
  assert.ok(
    index("Execute one unpaid authenticated shared-queue canary") <
      index("Independently verify stored acceptance and finish the cold release")
  )
  assert.match(
    steps[index("Hold admission and stop the worker on cold release uncertainty")].if,
    /always\(\)/
  )
  assert.equal(runtime.on.workflow_call.inputs.cold_release.default, false)
})
test("sandbox signature and actual native config drift fail closed", () => {
  const selector = JSON.parse(readFileSync(".github/cold-sandbox-publication.json", "utf8"))
  const config = "sha256:" + "1".repeat(64),
    manifest = "sha256:" + "2".repeat(64)
  const dependencies = {
    verifyInventory: () => ({
      qualified: false,
      nativeInventoryRechecked: true,
      nativeManifests: { amd64: manifest },
    }),
    verifyPublication: () => ({
      signedBoundedCoverageVerified: true,
      inventoryBindings: { amd64: { configDigest: config } },
    }),
    docker: (args) =>
      args[0] === "buildx"
        ? JSON.stringify({ config: { digest: config } })
        : args[0] === "pull"
          ? ""
          : JSON.stringify([
              {
                Id: config,
                Architecture: "amd64",
                Os: "linux",
                RepoDigests: ["ghcr.io/ecryptoguru/lyrashield-sandbox@" + selector.sandboxDigest],
              },
            ]),
  }
  assert.equal(
    verifyColdSandbox(selector, selector.engineRevision, dependencies).configDigest,
    config
  )
  assert.throws(() => verifyColdSandbox(selector, "f".repeat(40), dependencies))
  assert.throws(() =>
    verifyColdSandbox(selector, selector.engineRevision, {
      ...dependencies,
      verifyInventory: () => {
        throw Error("bad signature")
      },
    })
  )
  assert.throws(() =>
    verifyColdSandbox(selector, selector.engineRevision, {
      ...dependencies,
      docker: (args) =>
        args[0] === "buildx"
          ? JSON.stringify({ config: { digest: "sha256:" + "3".repeat(64) } })
          : dependencies.docker(args),
    })
  )
})
