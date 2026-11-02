import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import test from "node:test"
/* eslint-disable security/detect-non-literal-fs-filename -- reads/writes only mock launcher-owned config/report paths and the fixed workflow URL */
import {
  assertOwnedContainer,
  fixtureEnvironment,
  ownedPort,
  runUserScanSlotRuntime,
} from "../run-user-scan-slot-runtime.mjs"

function fixture({ failMigration = false, skipped = false, remote = false } = {}) {
  const records = new Map()
  const calls = []
  const run = async (binary, args, options) => {
    calls.push({ binary, args, options })
    if (args[0] === "context") return JSON.stringify(remote ? "ssh://remote" : "unix:///local.sock")
    if (args[0] === "create") {
      const id = String(records.size + 1).repeat(64)
      const identity = args[args.indexOf("--label") + 1].split("=")[1]
      const binding = args[args.indexOf("--publish") + 1]
      const port = binding.split(":").at(-1)
      const image = args.at(-1)
      assert.equal(binding, `127.0.0.1::${port}`)
      records.set(id, {
        Id: id,
        Config: { Image: image, Labels: { "lyrashield.user-scan-slot-fixture": identity } },
        HostConfig: { NetworkMode: "default" },
        State: { Running: false },
        NetworkSettings: {
          Ports: { [`${port}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: `5${port}` }] },
        },
      })
      return id
    }
    if (args[0] === "inspect") return JSON.stringify([records.get(args[1])])
    if (args[0] === "start") {
      records.get(args[1]).State.Running = true
      return args[1]
    }
    if (args[0] === "rm") {
      assert.ok(records.delete(args.at(-1)))
      return args.at(-1)
    }
    if (binary === "pnpm" && args.includes("prisma")) {
      const config = await readFile(args[args.indexOf("--config") + 1], "utf8")
      assert.doesNotMatch(config, /loadEnvFile|dotenv|prisma\.config\.ts/)
      assert.match(config, /url: process\.env\.DATABASE_URL/)
      if (failMigration) throw new Error("injected migration failure")
      return "migrated"
    }
    if (binary === "pnpm" && args.includes("vitest")) {
      const config = await readFile(args[args.indexOf("--config") + 1], "utf8")
      assert.doesNotMatch(config, /loadEnvFile|dotenv|vitest\.config\.ts/)
      const testResults = [
        ["apps/worker/src/user-scan-slot.runtime.test.ts", 12],
        ["apps/worker/src/user-scan-slot.fixture.test.ts", 2],
      ].map(([name, count]) => ({
        name,
        assertionResults: Array.from({ length: count }, () => ({
          status: skipped ? "pending" : "passed",
        })),
      }))
      await writeFile(
        args.find((arg) => arg.startsWith("--outputFile=")).split("=")[1],
        JSON.stringify({ testResults })
      )
      return "tests finished"
    }
    if (args.includes("SET")) return "OK"
    if (args.includes("-At")) return "0|0|0"
    return "ready"
  }
  return { run, records, calls }
}

test("sanitizes inherited services, provider credentials and connection/preload overrides", () => {
  const env = fixtureEnvironment({
    PATH: "/bin",
    HOME: "/fixture",
    DATABASE_URL: "private",
    REDIS_URL: "private",
    OPENAI_API_KEY: "private",
    PGHOST: "remote",
    NODE_OPTIONS: "--import malicious",
    DOCKER_HOST: "ssh://remote",
  })
  assert.equal(env.PATH, "/bin")
  for (const key of [
    "DATABASE_URL",
    "REDIS_URL",
    "OPENAI_API_KEY",
    "PGHOST",
    "NODE_OPTIONS",
    "DOCKER_HOST",
  ])
    assert.equal(env[key], undefined)
})

test("rejects wrong ID, wrong ownership, image, nonloopback, ambiguous or stopped bindings", () => {
  const expected = { id: "a".repeat(64), identity: "owned", image: "redis:7-alpine", port: 6379 }
  const good = {
    Id: expected.id,
    Config: { Image: expected.image, Labels: { "lyrashield.user-scan-slot-fixture": "owned" } },
    State: { Running: true },
    HostConfig: {},
    NetworkSettings: { Ports: { "6379/tcp": [{ HostIp: "127.0.0.1", HostPort: "12345" }] } },
  }
  assert.equal(ownedPort(good, expected), "12345")
  for (const modify of [
    (r) => {
      r.Id = "b".repeat(64)
    },
    (r) => {
      r.Config.Labels = {}
    },
    (r) => {
      r.Config.Image = "other"
    },
  ]) {
    const record = structuredClone(good)
    modify(record)
    assert.throws(() => assertOwnedContainer(record, expected))
  }
  for (const modify of [
    (r) => {
      r.State.Running = false
    },
    (r) => {
      r.HostConfig.NetworkMode = "host"
    },
    (r) => {
      r.NetworkSettings.Ports["6379/tcp"][0].HostIp = "0.0.0.0"
    },
    (r) => {
      r.NetworkSettings.Ports["6379/tcp"].push({ HostIp: "127.0.0.1", HostPort: "12345" })
    },
    (r) => {
      r.NetworkSettings.Ports["6379/tcp"][0].HostPort = "99999"
    },
  ]) {
    const record = structuredClone(good)
    modify(record)
    assert.throws(() => ownedPort(record, expected))
  }
})

test("provisions fresh endpoints, executes both suites and removes only exact owned IDs", async () => {
  const f = fixture()
  await runUserScanSlotRuntime({
    run: f.run,
    source: { PATH: process.env.PATH, DATABASE_URL: "inherited", REDIS_URL: "inherited" },
  })
  assert.equal(f.records.size, 0)
  const migration = f.calls.find((c) => c.args.includes("prisma"))
  const execution = f.calls.find((c) => c.args.includes("vitest"))
  const database = new URL(execution.options.env.DATABASE_URL)
  assert.match(database.pathname, /^\/task3_admission_test_[a-f0-9]{32}$/)
  assert.equal(new URL(execution.options.env.RLS_RUNTIME_DATABASE_URL).pathname, database.pathname)
  assert.equal(migration.options.env.DATABASE_URL, execution.options.env.DATABASE_URL)
  const password = database.password
  assert.ok(password.length >= 48)
  for (const c of f.calls)
    assert.ok(!c.args.join(" ").includes(password), "credentials must not enter process arguments")
  assert.equal(f.calls.filter((c) => c.args[0] === "rm").length, 2)
  for (const c of f.calls.filter((c) => c.args[0] === "rm"))
    assert.deepEqual(c.args.slice(0, 3), ["rm", "--force", "--volumes"])
})

test("migration failure cleans both created resources and never marks Redis or runs tests", async () => {
  const f = fixture({ failMigration: true })
  await assert.rejects(runUserScanSlotRuntime({ run: f.run }), /injected migration failure/)
  assert.equal(f.records.size, 0)
  assert.ok(!f.calls.some((c) => c.args.includes("SET") || c.args.includes("vitest")))
})

test("a green runner with skipped fixture cases fails the launcher and still cleans resources", async () => {
  const f = fixture({ skipped: true })
  await assert.rejects(runUserScanSlotRuntime({ run: f.run }), /no skips\/failures/)
  assert.equal(f.records.size, 0)
})

test("remote Docker context fails before provisioning any resource", async () => {
  const f = fixture({ remote: true })
  await assert.rejects(runUserScanSlotRuntime({ run: f.run }), /local Unix-socket/)
  assert.equal(f.calls.length, 1)
})

test("an interrupted test command still performs cleanup without the aborted signal", async () => {
  const f = fixture()
  const controller = new AbortController()
  const run = async (binary, args, options) => {
    if (binary === "pnpm" && args.includes("vitest")) {
      controller.abort()
      throw new Error("injected interruption")
    }
    if (args[0] === "rm") assert.equal(options.signal, undefined)
    return f.run(binary, args, options)
  }
  await assert.rejects(
    runUserScanSlotRuntime({ run, signal: controller.signal }),
    /injected interruption/
  )
  assert.equal(f.records.size, 0)
  assert.equal(f.calls.filter((c) => c.args[0] === "rm").length, 2)
})

test("ownership loss refuses deletion rather than removing an unowned container", async () => {
  const f = fixture()
  const run = async (binary, args, options) => {
    if (args[0] === "start") {
      f.records.get(args[1]).Config.Labels = {}
      throw new Error("injected ownership loss")
    }
    return f.run(binary, args, options)
  }
  await assert.rejects(runUserScanSlotRuntime({ run }), /Exact owned-container cleanup failed/)
  assert.ok(!f.calls.some((c) => c.args[0] === "rm"))
})

test("maintained workflow executes fail-closed launcher under database-test routing", async () => {
  const source = await readFile(new URL("../../workflows/ci.yml", import.meta.url), "utf8")
  const step = source
    .split("      - name: User scan slot concurrency with owned disposable services\n")[1]
    ?.split("      - name:")[0]
  assert.ok(step)
  assert.match(step, /if: needs\.changes\.outputs\.database-tests == 'true'/)
  assert.match(step, /timeout-minutes: 8/)
  assert.match(
    step,
    /run: node \.github\/scripts\/run-user-scan-slot-runtime\.mjs "\$RUNNER_TEMP\/user-scan-slot\.json"/
  )
})
