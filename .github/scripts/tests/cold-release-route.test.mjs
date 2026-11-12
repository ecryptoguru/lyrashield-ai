import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
import { execFileSync, spawnSync } from "node:child_process"
import test from "node:test"
import { runInNewContext } from "node:vm"
import { assertColdReleaseCaller } from "../assert-cold-release-caller.mjs"
import {
  coldHostScript,
  coldIdentity,
  invokeColdScript,
  parseColdProof,
} from "../cold-release-azure.mjs"
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
      Buffer.from(JSON.stringify({ scanId: "fixture" })).toString("base64url"),
      { verification: "[]", expected: "{}" }
    )
    assert.equal(spawnSync("sh", ["-n"], { input: script }).status, 0, operation)
    assert.doesNotMatch(script, /\/usr\/bin\/gh|(?:^|\n)\s*gh\s+attestation/)
    assert.match(script, /COLD_AZURE_OK/)
  }
  const finish = coldHostScript("finish", tuple, "e30")
  assert.ok(finish.indexOf("proof.get('result')!='MATCH'") < finish.indexOf("health_path="))
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
      index("Record pre-open qualification and release only the owned admission hold")
  )
  assert.ok(
    index("Monitor one unpaid authenticated shared-queue URL canary") <
      index("Independently verify stored post-release URL health")
  )
  assert.match(
    steps[index("Hold admission and stop the worker on cold release uncertainty")].if,
    /always\(\)/
  )
  assert.equal(runtime.on.workflow_call.inputs.cold_release.default, false)
})
test("cold sandbox verification resolves the worker's installed TypeScript loader", () => {
  const harness = parse(readFileSync(".github/workflows/verify-webhook-worker-image.yml", "utf8"))
  const step = harness.jobs["verify-worker-image"].steps.find(
    (entry) => entry.name === "Reauthenticate immutable sandbox publication and native inventory"
  )
  assert.equal(step["working-directory"], "product/apps/worker")
  assert.equal(
    step.run.split("\n")[0],
    "node --import tsx ../../.github/scripts/verify-cold-sandbox.mjs"
  )
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "../../.github/scripts/verify-cold-sandbox.mjs"],
    {
      cwd: "apps/worker",
      encoding: "utf8",
      env: { PATH: process.env.PATH, EXPECTED_ENGINE_REVISION: "invalid" },
    }
  )
  assert.equal(result.status, 1)
  assert.match(
    result.stderr,
    /Cold sandbox publication or native image binding verification failed/
  )
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/)
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

test("generated shell emits separately framed proof and success lines", () => {
  const directory = mkdtempSync(join(tmpdir(), "cold-proof-test-"))
  try {
    const expected = { version: 1, result: "MATCH", checksum: "fixture" }
    writeFileSync(join(directory, "proof-result.json"), JSON.stringify(expected))
    const script = coldHostScript("proof", coldIdentity(env), "e30")
    const fragment = script
      .slice(script.indexOf("printf 'COLD_PROOF:'"))
      .replaceAll("$state", directory)
    // Execute the actual generated framing, rather than inspect escape text.
    const result = execFileSync("sh", ["-c", fragment]).toString()
    assert.deepEqual(parseColdProof(result), expected)
    assert.match(result, /\nCOLD_AZURE_OK\n$/)
    assert.throws(() => parseColdProof(result.replace("\nCOLD_AZURE_OK", "\\nCOLD_AZURE_OK")))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("large native evidence travels via a protected @file with bounded exec argv", () => {
  const script = coldHostScript("prepare", coldIdentity(env), "", {
    verification: JSON.stringify({ transcript: "v".repeat(512 * 1024) }),
    expected: JSON.stringify({ predicate: "e".repeat(512 * 1024) }),
  })
  assert.ok(Buffer.byteLength(script) > 131072)
  let stagedPath
  const message = invokeColdScript(
    script,
    { WORKER_VM_NAME: "fixture", RG: "fixture" },
    (_command, args) => {
      assert.ok(args.every((value) => Buffer.byteLength(value) < 1024))
      stagedPath = args[args.indexOf("--scripts") + 1].slice(1)
      assert.equal(readFileSync(stagedPath, "utf8"), script)
      // A real process reads the staged body through an argv-sized path. This
      // executes on Linux CI too, where the old body argument raised E2BIG.
      const child = execFileSync(process.execPath, [
        "-e",
        'const fs=require("node:fs");if(fs.readFileSync(process.argv[1],"utf8").length<131072)process.exit(1);process.stdout.write(JSON.stringify({value:[{message:"COLD_AZURE_OK\\n"}]}));',
        stagedPath,
      ])
      return child
    }
  )
  assert.equal(message, "COLD_AZURE_OK\n")
  assert.equal(existsSync(stagedPath), false)
})

test("cold post-promotion failure retains rollback revisions and restores full fleet traffic", () => {
  const steps = parse(readFileSync(".github/workflows/deploy-azure-runtime.yml", "utf8")).jobs
    .deploy.steps
  for (const name of [
    "Refresh Azure OIDC login before ordinary failure cleanup",
    "Roll back production traffic on health failure",
    "Restore prior ingress mode after failed rollout",
    "Deactivate zero-traffic candidates after failed rollout",
  ]) {
    const condition = steps.find((step) => step.name === name).if
    assert.match(condition, /inputs.cold_release == true/)
    assert.match(condition, /steps.cold-finish.outcome != 'success'/)
  }
  for (const name of [
    "Deactivate superseded Container App revisions",
    "Remove excess scanner secrets",
  ]) {
    assert.match(
      steps.find((step) => step.name === name).if,
      /steps.cold-finish.outcome == 'success'/
    )
  }
})

test("pre-open qualification is durable before admission release and survives a missed post-release result", () => {
  const promoter = readFileSync(".github/scripts/promote-worker-vm.sh", "utf8")
  const open = promoter.slice(
    promoter.indexOf(
      'if [ "$cold_release" -eq 1 ] && [ "$cold_operation" = open-admission ]; then'
    ),
    promoter.indexOf("assert_cutover_receipt()")
  )
  assert.ok(open.indexOf("os.fsync(directory)") < open.indexOf("cold_owned_hold release"))
  assert.match(open, /pre-open-qualified.json/)
  assert.doesNotMatch(open, /acceptance-pending/)
  const prepare = coldHostScript("prepare", coldIdentity(env), "", {
    verification: "[]",
    expected: "{}",
  })
  assert.doesNotMatch(prepare, /cold-acceptance-pending/)
  const finish = coldHostScript("finish", coldIdentity(env), "e30")
  assert.match(finish, /post-release-health.json/)
  assert.doesNotMatch(finish, /os.rename\(path/)
})

test("containment always stops on Redis uncertainty and succeeds only on independent hold/native readback", () => {
  const promoter = readFileSync(".github/scripts/promote-worker-vm.sh", "utf8")
  const start = promoter.indexOf(
    'if [ "$cold_release" -eq 1 ] && [ "$cold_operation" = contain ]; then'
  )
  const body = promoter.slice(start, promoter.indexOf("# Validate ownership before", start))
  const directory = mkdtempSync(join(tmpdir(), "cold-contain-test-"))
  try {
    for (const [scenario, success] of [
      ["ack", true],
      ["claim-lost-ack", true],
      ["stop-lost-ack", true],
      ["redis-unavailable", false],
      ["changed-hold", false],
      ["native-running", false],
    ]) {
      const stoppedPath = join(directory, scenario)
      const script =
        `set -eu
cold_release=1; cold_operation=contain; timer=timer; service=service; container=worker
hold=0; active=1
cold_owned_hold() {
 case "$1" in
 claim) [ "$SCENARIO" != redis-unavailable ] && [ "$SCENARIO" != changed-hold ] || return 1; hold=1; [ "$SCENARIO" != claim-lost-ack ] || return 1 ;;
 assert) [ "$hold" = 1 ] ;;
 esac
 printf 'COLD_HOLD_VERIFIED\\n'
}
systemctl() {
 if [ "$1" = stop ]; then printf stopped > "$STOPPED_PATH"; active=0; [ "$SCENARIO" != stop-lost-ack ]; return; fi
 case "$*" in *ActiveState*) [ "$active" = 0 ] && printf inactive || printf active ;; *MainPID*) [ "$active" = 0 ] && printf 0 || printf 123 ;; *) return 1 ;; esac
}
docker() { [ "$SCENARIO" != native-running ] || printf running; }
` + body
      const result = spawnSync("sh", ["-c", script], {
        env: { ...process.env, SCENARIO: scenario, STOPPED_PATH: stoppedPath },
        encoding: "utf8",
      })
      assert.equal(result.status === 0, success, scenario + result.stderr)
      assert.equal(existsSync(stoppedPath), true, scenario)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("full fleet cleanup evaluates false without verified cold containment for every post-release failure", () => {
  const steps = parse(readFileSync(".github/workflows/deploy-azure-runtime.yml", "utf8")).jobs
    .deploy.steps
  for (const name of [
    "Refresh Azure OIDC login before ordinary failure cleanup",
    "Roll back production traffic on health failure",
    "Restore prior ingress mode after failed rollout",
    "Deactivate zero-traffic candidates after failed rollout",
  ]) {
    const condition = steps
      .find((step) => step.name === name)
      .if.replace(/steps\.([a-z0-9-]+)/g, 'steps["$1"]')
    for (const failureStep of ["cold-open", "cold-canary", "cold-finish", "promote"]) {
      for (const contained of ["success", "failure", "cancelled"]) {
        const fixture = {
          inputs: { cold_release: true, held_recovery: false, webhook_claims_cutover: false },
          env: { V26_CUTOVER: "false" },
          steps: Object.fromEntries(
            steps
              .filter((step) => step.id)
              .map((step) => [step.id, { outcome: "success", outputs: {} }])
          ),
          failure: () => true,
        }
        fixture.steps["deploy-app"].outputs.previous_client_cert_mode = "Ignore"
        fixture.steps[failureStep].outcome = "failure"
        fixture.steps["cold-finish"].outcome = "skipped"
        fixture.steps["cold-contain"].outcome = contained
        assert.equal(
          runInNewContext(condition, fixture, { timeout: 1000 }),
          contained === "success",
          name + failureStep + contained
        )
      }
    }
  }
})

test("containerd index image identity requires actual store mode and unique signed native manifest", () => {
  const selector = JSON.parse(readFileSync(".github/cold-sandbox-publication.json", "utf8"))
  const manifest = "sha256:" + "2".repeat(64),
    config = "sha256:" + "1".repeat(64)
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
      args[0] === "pull"
        ? ""
        : args[0] === "info"
          ? JSON.stringify([["driver-type", "io.containerd.snapshotter.v1"]])
          : args[0] === "image"
            ? JSON.stringify([
                {
                  Id: selector.sandboxDigest,
                  Architecture: "amd64",
                  Os: "linux",
                  RepoDigests: ["ghcr.io/ecryptoguru/lyrashield-sandbox@" + selector.sandboxDigest],
                },
              ])
            : JSON.stringify(
                args[3].endsWith(manifest)
                  ? { config: { digest: config } }
                  : {
                      manifests: [
                        { digest: manifest, platform: { os: "linux", architecture: "amd64" } },
                      ],
                    }
              ),
  }
  assert.equal(
    verifyColdSandbox(selector, selector.engineRevision, dependencies).nativeManifest,
    manifest
  )
  for (const invalid of [[], [["driver-type", "overlay2"]]]) {
    assert.throws(() =>
      verifyColdSandbox(selector, selector.engineRevision, {
        ...dependencies,
        docker: (args) =>
          args[0] === "info" ? JSON.stringify(invalid) : dependencies.docker(args),
      })
    )
  }
  assert.throws(() =>
    verifyColdSandbox(selector, selector.engineRevision, {
      ...dependencies,
      docker: (args) =>
        args[0] === "buildx" && !args[3].endsWith(manifest)
          ? JSON.stringify({
              manifests: [{ digest: config, platform: { os: "linux", architecture: "amd64" } }],
            })
          : dependencies.docker(args),
    })
  )
})

test("held admission drains naturally with a bounded deadline and never restarts queued work", () => {
  const promoter = readFileSync(".github/scripts/promote-worker-vm.sh", "utf8")
  const body = promoter.slice(
    promoter.indexOf("wait_cold_queues_drained()"),
    promoter.indexOf("assert_cold_paid_authority()")
  )
  const directory = mkdtempSync(join(tmpdir(), "cold-drain-test-"))
  try {
    for (const scenario of ["drains", "timeout"]) {
      const script =
        `set -eu
recovery_queue_count='read-only counts'; recovery_queue_expected=empty
printf 0 > "$COUNTER"; printf 0 > "$CLOCK"
date() { cat "$CLOCK"; }
sleep() { now=$(cat "$CLOCK"); printf '%s' "$((now + 300))" > "$CLOCK"; }
worker_oneshot() { count=$(cat "$COUNTER"); count=$((count + 1)); printf '%s' "$count" > "$COUNTER"; if [ "$SCENARIO" = drains ] && [ "$count" -ge 3 ]; then printf empty; else printf busy; fi; }
` +
        body +
        "\nwait_cold_queues_drained\n"
      const result = spawnSync("sh", ["-c", script], {
        env: {
          ...process.env,
          SCENARIO: scenario,
          COUNTER: join(directory, "counter"),
          CLOCK: join(directory, "clock"),
        },
        encoding: "utf8",
      })
      assert.equal(result.status === 0, scenario === "drains", result.stderr)
      assert.equal(readFileSync(join(directory, "counter"), "utf8"), "3")
      if (scenario === "timeout") assert.match(result.stderr, /admission remains held/)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("production startup has a real isolated native socket before worker launch", () => {
  const harness = parse(readFileSync(".github/workflows/verify-webhook-worker-image.yml", "utf8"))
  const script = harness.jobs["verify-worker-image"].steps.find(
    (step) =>
      step.name === "Boot the exact worker image to readiness with production startup checks"
  ).run
  assert.equal(spawnSync("bash", ["-n"], { input: script }).status, 0)
  assert.match(script, /--privileged --network none/)
  assert.ok(script.includes("--host=unix:///cold/docker.sock"))
  assert.ok(script.includes("type=volume,src=$socket_volume,dst=/cold"))
  assert.ok(
    script.includes('--group-add "$socket_group" --env DOCKER_HOST=unix:///cold/docker.sock')
  )
  assert.ok(
    script.indexOf("container ls --all --quiet") <
      script.indexOf('"${cold_flags[@]}" "$CANONICAL_WORKER_IMAGE"')
  )
  assert.doesNotMatch(script, /src=\/var\/run\/docker.sock|tcp:\/\//)
})
