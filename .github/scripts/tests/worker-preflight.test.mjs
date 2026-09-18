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

  const workerRedisSync = workflow
    .split("      - name: Sync BullMQ Redis secret to worker Key Vault\n")[1]
    ?.split("\n      - name:")[0]
  assert.ok(workerRedisSync)
  assert.match(workerRedisSync, /--name worker-redis-url/)
  assert.match(workerRedisSync, /BULLMQ_REDIS_URL/)

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

const preflightDockerStub = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$DOCKER_LOG"',
  'case "$1:$2" in',
  "  image:inspect)",
  '    case "$*" in',
  "      *org.opencontainers.image.revision*) printf '%s\\n' 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' ;;",
  "      *io.lyrashield.engine.revision*) printf '%s\\n' 'cccccccccccccccccccccccccccccccccccccccc' ;;",
  "      *) exit 1 ;;",
  "    esac ;;",
  "  run:*)",
  "    printf '%s\\n' \"$QUEUE_STATE\" ;;",
  "  exec:lyrashield-worker)",
  '    case "$*" in',
  "      *printenv\\ REDIS_URL*) printf '%s\\n' \"$MOCK_LIVE_REDIS_URL\" ;;",
  "      *printenv\\ DATABASE_URL*) printf '%s\\n' \"$MOCK_LIVE_DATABASE_URL\" ;;",
  "      *) exit 1 ;;",
  "    esac ;;",
  "  *) exit 1 ;;",
  "esac",
].join("\n")

const preflightEnvFile = [
  "DATABASE_URL=postgres://worker:secret@postgres.internal:5432/lyrashield",
  "DATABASE_SYSTEM_URL=postgres://worker:secret@postgres.internal:5432/lyrashield",
  "REDIS_URL=rediss://default:secret@redis.internal:6379",
  `BETTER_AUTH_SECRET=${"a".repeat(32)}`,
  "BETTER_AUTH_URL=https://app.lyrashieldai.com",
  "NEXT_PUBLIC_APP_URL=https://app.lyrashieldai.com",
  "TRUSTED_PROXY_IP_HEADER=cf-connecting-ip",
  "LYRASHIELD_WEB_SEARCH_API_KEY=test-search-key",
  "GHCR_TOKEN=test-token",
  "",
].join("\n")

// Parses the `docker run` line the stub recorded into the environment the
// one-shot container would see: --env-file pairs first, then --env overrides.
const preflightRunEnvironment = (dockerLog) => {
  const runLine = readFileSync(dockerLog, "utf8")
    .split("\n")
    .find((line) => line.startsWith("run "))
  assert.ok(runLine, "preflight did not run a one-shot container")
  const tokens = runLine.split(" ")
  const env = {}
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--env-file") {
      for (const line of readFileSync(tokens[++i], "utf8").split("\n")) {
        if (!line || line.startsWith("#")) continue
        const separator = line.indexOf("=")
        env[line.slice(0, separator)] = line.slice(separator + 1)
      }
    }
    if (tokens[i] === "--env") {
      const separator = tokens[++i].indexOf("=")
      env[tokens[i].slice(0, separator)] = tokens[i].slice(separator + 1)
    }
  }
  return { env, tokens }
}

test("worker preflight reads refreshed Key Vault credentials without restarting the active worker", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "worker-preflight-"))
  try {
    const dockerLog = path.join(directory, "docker.log")
    const systemctlLog = path.join(directory, "systemctl.log")
    const runtimeConfig = path.join(directory, "worker-runtime.conf")
    const envFile = path.join(directory, "worker.env")
    writeFileSync(path.join(directory, "docker"), preflightDockerStub, { mode: 0o700 })
    writeFileSync(
      path.join(directory, "systemctl"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"\n',
      {
        mode: 0o700,
      }
    )
    writeFileSync(
      runtimeConfig,
      "LYRASHIELD_WORKER_IMAGE=ghcr.io/example/worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" +
        "LYRASHIELD_SANDBOX_IMAGE=ghcr.io/example/sandbox@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\n"
    )
    writeFileSync(envFile, preflightEnvFile)
    const empty = {
      nonterminal: 0,
      scan: { wait: 0, active: 0, delayed: 0, prioritized: 0 },
      webhook: { wait: 0, active: 0, delayed: 0, prioritized: 0 },
    }
    const run = (state) =>
      execFileSync("/bin/sh", [".github/scripts/promote-worker-vm.sh", "--preflight"], {
        env: {
          PATH: directory + path.delimiter + process.env.PATH,
          QUEUE_STATE: state,
          DOCKER_LOG: dockerLog,
          SYSTEMCTL_LOG: systemctlLog,
          MOCK_LIVE_REDIS_URL: "rediss://default:other@redis.internal:6379",
          MOCK_LIVE_DATABASE_URL: "postgres://worker:other@postgres.internal:5432/lyrashield",
          LYRASHIELD_WORKER_RUNTIME_CONFIG: runtimeConfig,
          LYRASHIELD_WORKER_ENV_FILE: envFile,
          LYRASHIELD_WORKER_ENV_LIB: path.resolve("ops/worker/worker-env.sh"),
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
    assert.match(run(JSON.stringify(empty)), /Worker empty-queue preflight passed/)
    assert.match(
      readFileSync(systemctlLog, "utf8"),
      /^restart lyrashield-worker-secrets\.service$/m
    )
    const { env, tokens } = preflightRunEnvironment(dockerLog)
    assert.equal(env.TMPDIR, "/tmp")
    assert.ok(tokens.includes("/tmp:rw,nosuid,nodev,noexec,size=64m"))
    assert.ok(!tokens.includes("--mount"))
    const passedNames = new Set()
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === "--env") passedNames.add(tokens[i + 1].split("=")[0])
    }
    for (const name of [
      "NODE_ENV",
      "PLATFORM_ADMIN_EMAILS",
      "LYRASHIELD_REQUIRE_EMAIL_VERIFICATION",
      "LYRASHIELD_RUNTIME_BACKEND",
      "LYRASHIELD_ENGINE_PATH",
      "LYRASHIELD_IMAGE",
      "LYRASHIELD_PRODUCT_REVISION",
      "LYRASHIELD_WORKER_IMAGE_DIGEST",
      "LYRASHIELD_ENGINE_REVISION",
    ]) {
      assert.ok(passedNames.has(name), `preflight is missing --env ${name}`)
    }
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

test("worker preflight reports a stale worker environment without printing endpoints", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "worker-preflight-stale-"))
  try {
    const dockerLog = path.join(directory, "docker.log")
    const systemctlLog = path.join(directory, "systemctl.log")
    const runtimeConfig = path.join(directory, "worker-runtime.conf")
    const envFile = path.join(directory, "worker.env")
    writeFileSync(path.join(directory, "docker"), preflightDockerStub, { mode: 0o700 })
    writeFileSync(
      path.join(directory, "systemctl"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"\n',
      {
        mode: 0o700,
      }
    )
    writeFileSync(
      runtimeConfig,
      "LYRASHIELD_WORKER_IMAGE=ghcr.io/example/worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" +
        "LYRASHIELD_SANDBOX_IMAGE=ghcr.io/example/sandbox@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\n"
    )
    writeFileSync(envFile, preflightEnvFile)
    const empty = {
      nonterminal: 0,
      scan: { wait: 0, active: 0, delayed: 0, prioritized: 0 },
      webhook: { wait: 0, active: 0, delayed: 0, prioritized: 0 },
    }
    const run = (liveRedisUrl, liveDatabaseUrl) =>
      execFileSync("/bin/sh", [".github/scripts/promote-worker-vm.sh", "--preflight"], {
        env: {
          PATH: directory + path.delimiter + process.env.PATH,
          QUEUE_STATE: JSON.stringify(empty),
          DOCKER_LOG: dockerLog,
          SYSTEMCTL_LOG: systemctlLog,
          MOCK_LIVE_REDIS_URL: liveRedisUrl,
          MOCK_LIVE_DATABASE_URL: liveDatabaseUrl,
          LYRASHIELD_WORKER_RUNTIME_CONFIG: runtimeConfig,
          LYRASHIELD_WORKER_ENV_FILE: envFile,
          LYRASHIELD_WORKER_ENV_LIB: path.resolve("ops/worker/worker-env.sh"),
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })

    // Same host[:port] on both sides passes.
    assert.match(
      run(
        "rediss://default:rotated@redis.internal:6379",
        "postgres://worker:rotated@postgres.internal:5432/lyrashield"
      ),
      /Worker empty-queue preflight passed/
    )

    // A rotated Redis or Postgres endpoint is named without exposing either
    // endpoint. The one-shot preflight can safely continue with its refreshed
    // environment so it can bootstrap the host asset that repairs the worker.
    const staleMessage =
      /Worker environment is stale; continuing with the refreshed one-shot preflight/
    for (const [liveRedis, liveDatabase] of [
      [
        "rediss://default:old@exhausted.upstash.io:6379",
        "postgres://worker:rotated@postgres.internal:5432/lyrashield",
      ],
      [
        "rediss://default:rotated@redis.internal:6379",
        "postgres://worker:old@retired.postgres.internal:5432/lyrashield",
      ],
      [
        "rediss://default:old@redis.internal:6380",
        "postgres://worker:rotated@postgres.internal:5432/lyrashield",
      ],
    ]) {
      const output = run(liveRedis, liveDatabase)
      assert.match(output, staleMessage)
      assert.doesNotMatch(
        output,
        /exhausted\.upstash\.io|retired\.postgres\.internal|redis\.internal:6380/
      )
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("preflight environment loads @lyrashield/config in production and matches the worker launcher", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "worker-preflight-env-"))
  try {
    const dockerLog = path.join(directory, "docker.log")
    const systemctlLog = path.join(directory, "systemctl.log")
    const runtimeConfig = path.join(directory, "worker-runtime.conf")
    const envFile = path.join(directory, "worker.env")
    writeFileSync(path.join(directory, "docker"), preflightDockerStub, { mode: 0o700 })
    writeFileSync(
      path.join(directory, "systemctl"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"\n',
      {
        mode: 0o700,
      }
    )
    writeFileSync(
      runtimeConfig,
      "LYRASHIELD_WORKER_IMAGE=ghcr.io/example/worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" +
        "LYRASHIELD_SANDBOX_IMAGE=ghcr.io/example/sandbox@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\n"
    )
    writeFileSync(envFile, preflightEnvFile)
    const empty = {
      nonterminal: 0,
      scan: { wait: 0, active: 0, delayed: 0, prioritized: 0 },
      webhook: { wait: 0, active: 0, delayed: 0, prioritized: 0 },
    }
    execFileSync("/bin/sh", [".github/scripts/promote-worker-vm.sh", "--preflight"], {
      env: {
        PATH: directory + path.delimiter + process.env.PATH,
        QUEUE_STATE: JSON.stringify(empty),
        DOCKER_LOG: dockerLog,
        SYSTEMCTL_LOG: systemctlLog,
        MOCK_LIVE_REDIS_URL: "rediss://default:other@redis.internal:6379",
        MOCK_LIVE_DATABASE_URL: "postgres://worker:other@postgres.internal:5432/lyrashield",
        LYRASHIELD_WORKER_RUNTIME_CONFIG: runtimeConfig,
        LYRASHIELD_WORKER_ENV_FILE: envFile,
        LYRASHIELD_WORKER_ENV_LIB: path.resolve("ops/worker/worker-env.sh"),
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })

    const { env, tokens } = preflightRunEnvironment(dockerLog)
    // (a) The preflight environment loads @lyrashield/config in production.
    // TMPDIR is pointed at a writable directory because the compile-time
    // worker root does not exist off the VM; every other value is passed
    // exactly as the preflight assembled it. The spawn cwd mirrors the
    // one-shot container's -w /app/apps/worker.
    const spawn = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", 'await import("@lyrashield/config")'],
      {
        cwd: path.resolve("apps/worker"),
        env: { ...env, NODE_ENV: "production", TMPDIR: directory },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    )
    assert.ok(spawn !== null)

    // (b) run-worker.sh and the preflight emit the same --env name set: the
    // worker-side names come from ops/worker/worker-env.sh, which both call.
    const workerNames = new Set()
    for (const file of ["ops/worker/worker-env.sh", "ops/worker/run-worker.sh"]) {
      let text = ""
      try {
        text = readFileSync(file, "utf8")
      } catch {
        continue
      }
      for (const match of text.matchAll(/--env ([A-Z_]+)=/g)) workerNames.add(match[1])
    }
    const passedNames = new Set()
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === "--env") passedNames.add(tokens[i + 1].split("=")[0])
    }
    assert.deepEqual([...passedNames].sort(), [...workerNames].sort())
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
