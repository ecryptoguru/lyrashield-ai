import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import assert from "node:assert/strict"
import { test } from "node:test"

test("public scanner revision and secret store exclude GitHub App credentials", () => {
  const workflow = readFileSync(".github/workflows/deploy-azure.yml", "utf8")
  const scannerDeploy = workflow
    .split("      - name: Deploy scanner Container App\n")[1]
    ?.split("\n      - name:")[0]
  assert.ok(scannerDeploy)
  for (const credential of [
    "GITHUB_APP_ID",
    "GITHUB_APP_SLUG",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_WEBHOOK_SECRET",
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_CLIENT_SECRET",
  ]) {
    assert.doesNotMatch(scannerDeploy, new RegExp(`${credential}=secretref:`))
    const removedEnv = scannerDeploy.split("--remove-env-vars")[1]?.split("--set-env-vars")[0]
    assert.ok(removedEnv)
    assert.match(removedEnv, new RegExp(`\\b${credential}\\b`))
  }
  assert.match(scannerDeploy, /REDIS_URL=secretref:bullmq-redis-url/)
  assert.match(scannerDeploy, /UPSTASH_REDIS_REST_TOKEN=secretref:upstash-redis-rest-token/)

  const githubSync = workflow
    .split("      - name: Sync GitHub App secrets to app Container App\n")[1]
    ?.split("\n      - name:")[0]
  assert.ok(githubSync)
  assert.doesNotMatch(githubSync, /AZURE_SCANNER_CONTAINER_APP_NAME/)

  const cleanup = workflow
    .split("      - name: Remove excess scanner secrets\n")[1]
    ?.split("\n      - name:")[0]
  assert.ok(cleanup)
  for (const secret of [
    "github-app-id",
    "github-app-slug",
    "github-app-private-key",
    "github-webhook-secret",
    "github-app-client-id",
    "github-app-client-secret",
  ]) {
    assert.match(cleanup, new RegExp(secret))
  }
})

test("worker preflight accepts only empty queues and needs no promotion configuration", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "worker-preflight-"))
  try {
    writeFileSync(path.join(directory, "docker"), '#!/bin/sh\nprintf "%s\\n" "$QUEUE_STATE"\n', {
      mode: 0o700,
    })
    const empty = {
      nonterminal: 0,
      scan: { wait: 0, active: 0, delayed: 0, prioritized: 0 },
      webhook: { wait: 0, active: 0, delayed: 0, prioritized: 0 },
    }
    const run = (state) =>
      execFileSync("/bin/sh", [".github/scripts/promote-worker-vm.sh", "--preflight"], {
        env: { PATH: directory, QUEUE_STATE: state },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
    assert.match(run(JSON.stringify(empty)), /Worker empty-queue preflight passed/)
    for (const state of [
      "",
      "not-json",
      JSON.stringify({ ...empty, nonterminal: 1 }),
      JSON.stringify({ ...empty, webhook: { ...empty.webhook, active: 1 } }),
    ]) {
      assert.throws(() => run(state))
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

for (const failure of ["busy-queue", "vm-error"]) {
  test(`workflow recovers ingress and candidates after ${failure}`, () => {
    const workflow = readFileSync(".github/workflows/deploy-azure.yml", "utf8")
    const preflight = workflow
      .split("      - name: Verify worker queues are empty before traffic promotion\n")[1]
      ?.split("\n      - name:")[0]
    assert.ok(preflight)
    assert.match(preflight, /id: worker-preflight/)
    const command = preflight
      .split("        run: |\n")[1]
      .split("\n")
      .map((line) => line.replace(/^          /, ""))
      .join("\n")
    const directory = mkdtempSync(path.join(tmpdir(), "worker-workflow-"))
    try {
      mkdirSync(path.join(directory, "ops/deployment"), { recursive: true })
      writeFileSync(
        path.join(directory, "ops/deployment/azure-vm-run-command.sh"),
        [
          "azure_vm_run_command_with_retry() {",
          '  if [ "$PREFLIGHT_FAILURE" = vm-error ]; then echo "VM unavailable" >&2; return 1; fi',
          '  printf "%s\\n" "Worker promotion requires empty scan and webhook queues"',
          "}",
        ].join("\n")
      )
      writeFileSync(path.join(directory, "base64"), '#!/bin/sh\nprintf "fixture-payload"\n', {
        mode: 0o700,
      })
      assert.throws(() =>
        execFileSync("/bin/bash", ["-e", "-o", "pipefail", "-c", command], {
          cwd: directory,
          env: {
            ...process.env,
            PATH: directory + path.delimiter + process.env.PATH,
            PREFLIGHT_FAILURE: failure,
          },
          stdio: ["ignore", "pipe", "pipe"],
        })
      )
      for (const name of [
        "Restore prior ingress mode after failed rollout",
        "Deactivate zero-traffic candidates after failed rollout",
      ]) {
        const condition = workflow
          .split("      - name: " + name + "\n")[1]
          ?.split("        env:")[0]
        assert.ok(condition)
        assert.match(condition, /failure\(\)/)
        assert.match(condition, /steps\.worker-preflight\.outcome == 'failure'/)
      }
      const trafficRollback = workflow
        .split("      - name: Roll back production traffic on health failure\n")[1]
        ?.split("        env:")[0]
      assert.ok(trafficRollback)
      assert.doesNotMatch(trafficRollback, /worker-preflight/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
}
