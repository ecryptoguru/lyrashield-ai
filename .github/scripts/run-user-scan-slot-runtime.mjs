import { execFile } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { assertFileCounts } from "./assert-vitest-file-counts.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const label = "lyrashield.user-scan-slot-fixture"
const images = { postgres: "postgres:16-alpine", redis: "redis:7-alpine" }

// Never forward inherited service URLs, provider keys, PG overrides or Node preloads.
export function fixtureEnvironment(source) {
  const env = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "PNPM_HOME", "SYSTEMROOT"].flatMap((key) =>
      source[key] ? [[key, source[key]]] : []
    )
  )
  return {
    ...env,
    NODE_ENV: "test",
    BETTER_AUTH_SECRET: "slot-fixture-only-secret-at-least-32-characters",
    BETTER_AUTH_URL: "http://127.0.0.1:3000",
    NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
    LYRASHIELD_REQUIRE_EMAIL_VERIFICATION: "0",
  }
}

export function assertOwnedContainer(record, expected) {
  if (
    !/^[a-f0-9]{64}$/.test(expected.id) ||
    record.Id !== expected.id ||
    record.Config?.Labels?.[label] !== expected.identity ||
    record.Config?.Image !== expected.image
  )
    throw new Error("Refusing container without exact created ID, image and ownership label")
}

export function ownedPort(record, expected) {
  assertOwnedContainer(record, expected)
  const bindings = record.NetworkSettings?.Ports?.[`${expected.port}/tcp`]
  if (
    record.State?.Running !== true ||
    record.HostConfig?.NetworkMode === "host" ||
    bindings?.length !== 1 ||
    bindings[0].HostIp !== "127.0.0.1" ||
    !/^[0-9]+$/.test(bindings[0].HostPort) ||
    Number(bindings[0].HostPort) < 1 ||
    Number(bindings[0].HostPort) > 65535
  )
    throw new Error("Refusing container without one running loopback fixture endpoint")
  return bindings[0].HostPort
}

function execute(command, args, options) {
  return new Promise((accept, reject) => {
    const child = execFile(
      command,
      args,
      {
        cwd: root,
        env: options.env,
        signal: options.signal,
        timeout: 180_000,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (options.verbose || error) {
          process.stdout.write(stdout)
          process.stderr.write(stderr)
        }
        if (error) reject(error)
        else accept(stdout.trim())
      }
    )
    child.stdin.end(options.input)
  })
}

async function exerciseFixture({
  command,
  directory,
  fixtureEnv,
  postgres,
  redis,
  containers,
  inspect,
  identity,
  report,
  database,
  runtimePassword,
}) {
  // Do not load packages/db/prisma.config.ts: its dotenv call can restore PG
  // overrides from the developer's .env even after sanitizing process.env.
  const migrationConfig = resolve(directory, "prisma.config.mjs")
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated fixture path
  await writeFile(
    migrationConfig,
    `export default { schema: ${JSON.stringify(resolve(root, "packages/db/prisma/schema.prisma"))}, migrations: { path: ${JSON.stringify(resolve(root, "packages/db/prisma/migrations"))} }, datasource: { url: process.env.DATABASE_URL } }\n`
  )
  await command(
    "pnpm",
    [
      "--filter",
      "@lyrashield/db",
      "exec",
      "prisma",
      "migrate",
      "deploy",
      "--config",
      migrationConfig,
    ],
    { env: fixtureEnv, verbose: true }
  )
  await command(
    "docker",
    [
      "exec",
      "-i",
      postgres.id,
      "psql",
      "-U",
      "slot_owner",
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
    ],
    {
      input: `CREATE ROLE slot_runtime LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT CONNECT ON DATABASE ${database} TO slot_runtime;
GRANT USAGE ON SCHEMA public, app TO slot_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Workspace", users, "Target", "Scan", "Schedule", "UserScanSlot", "ScanEvent", "ScanCapacityReservation", "AuditLog", agent_operations, agent_connections TO slot_runtime;`,
    }
  )
  // Reverify both exact bindings before installing the Redis ownership marker.
  for (const owned of containers)
    if (ownedPort(await inspect(owned.id), owned) !== owned.hostPort)
      throw new Error("Fixture endpoint changed before test execution")
  const marked = await command("docker", [
    "exec",
    redis.id,
    "redis-cli",
    "SET",
    "lyrashield:test-fixture:user-scan-slot",
    identity,
    "NX",
  ])
  if (marked !== "OK") throw new Error("Fresh Redis ownership marker was not created")
  // A dedicated config avoids loading the developer's .env through vitest.config.ts.
  const config = resolve(directory, "vitest.config.mjs")
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated fixture path
  await writeFile(
    config,
    `export default ${JSON.stringify({ root, test: { include: ["apps/worker/src/user-scan-slot.runtime.test.ts", "apps/worker/src/user-scan-slot.fixture.test.ts"], maxWorkers: 1 } })}\n`
  )
  await command(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--config",
      config,
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    { env: fixtureEnv, verbose: true }
  )
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit caller report path, read-only
  assertFileCounts(JSON.parse(await readFile(report, "utf8")), [
    ["apps/worker/src/user-scan-slot.runtime.test.ts", 12],
    ["apps/worker/src/user-scan-slot.fixture.test.ts", 2],
  ])
  const remaining = await command("docker", [
    "exec",
    postgres.id,
    "psql",
    "-U",
    "slot_owner",
    "-d",
    database,
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    'SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM "Workspace"), (SELECT count(*) FROM "UserScanSlot")',
  ])
  if (remaining !== "0|0|0") throw new Error("Disposable fixture rows were not fully cleaned")
  console.log("fixture row cleanup: users=0, workspaces=0, slots=0")
}

/** Fresh services only; no caller-supplied database or Redis endpoint is accepted. */
export async function runUserScanSlotRuntime({
  run = execute,
  source = process.env,
  reportPath,
  signal,
} = {}) {
  const env = fixtureEnvironment(source)
  const identity = randomUUID()
  const database = `task3_admission_test_${identity.replaceAll("-", "")}`
  const directory = await mkdtemp(resolve(tmpdir(), "lyra-user-slot-"))
  const containers = []
  const command = (binary, args, options = {}) => run(binary, args, { env, signal, ...options })
  const inspect = async (id, cleanup = false) =>
    JSON.parse(await command("docker", ["inspect", id], cleanup ? { signal: undefined } : {}))[0]
  const report = resolve(reportPath || resolve(directory, "results.json"))
  try {
    // Remote Docker contexts are not disposable local execution environments.
    const endpoint = JSON.parse(
      await command("docker", ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"])
    )
    if (typeof endpoint !== "string" || !endpoint.startsWith("unix:///"))
      throw new Error("Requires a local Unix-socket Docker context")
    const ownerPassword = randomBytes(24).toString("hex")
    const runtimePassword = randomBytes(24).toString("hex")
    const envFile = resolve(directory, "postgres.env")
    // Generated inside this invocation's private mkdtemp directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(
      envFile,
      `POSTGRES_USER=slot_owner\nPOSTGRES_PASSWORD=${ownerPassword}\nPOSTGRES_DB=${database}\n`,
      { mode: 0o600 }
    )
    for (const [kind, port] of [
      ["postgres", 5432],
      ["redis", 6379],
    ]) {
      const image = images[kind]
      const id = await command("docker", [
        "create",
        "--label",
        `${label}=${identity}`,
        "--publish",
        `127.0.0.1::${port}`,
        ...(kind === "postgres" ? ["--env-file", envFile] : []),
        image,
      ])
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Docker did not return an exact container ID")
      const owned = { id, identity, image, port }
      containers.push(owned)
      assertOwnedContainer(await inspect(id), owned)
      await command("docker", ["start", id])
      owned.hostPort = ownedPort(await inspect(id), owned)
      console.log(`owned ${kind}: ${id}, loopback port ${owned.hostPort}, fixture ${identity}`)
    }
    const [postgres, redis] = containers
    // Bounded readiness without writing to an inherited listener.
    for (let attempt = 0; ; attempt++) {
      try {
        await command("docker", [
          "exec",
          postgres.id,
          "pg_isready",
          "-U",
          "slot_owner",
          "-d",
          database,
        ])
        await command("docker", ["exec", redis.id, "redis-cli", "ping"])
        break
      } catch (error) {
        if (attempt >= 29 || signal?.aborted) throw error
        await new Promise((accept) => setTimeout(accept, 1000))
      }
    }
    const ownerUrl = `postgresql://slot_owner:${ownerPassword}@127.0.0.1:${postgres.hostPort}/${database}`
    const fixtureEnv = {
      ...env,
      LYRASHIELD_TEST_DB_DISPOSABLE: "1",
      USER_SCAN_SLOT_RUNTIME_TEST: "1",
      USER_SCAN_SLOT_REDIS_FIXTURE_ID: identity,
      DATABASE_URL: ownerUrl,
      DATABASE_DIRECT_URL: ownerUrl,
      DATABASE_SYSTEM_URL: ownerUrl,
      RLS_RUNTIME_DATABASE_URL: `postgresql://slot_runtime:${runtimePassword}@127.0.0.1:${postgres.hostPort}/${database}`,
      REDIS_URL: `redis://127.0.0.1:${redis.hostPort}`,
    }
    await exerciseFixture({
      command,
      directory,
      fixtureEnv,
      postgres,
      redis,
      containers,
      inspect,
      identity,
      report,
      database,
      runtimePassword,
    })
  } finally {
    const errors = []
    for (const owned of containers.reverse()) {
      try {
        assertOwnedContainer(await inspect(owned.id, true), owned)
        await command("docker", ["rm", "--force", "--volumes", owned.id], { signal: undefined })
        console.log(`removed owned container and anonymous volumes: ${owned.id}`)
      } catch (error) {
        errors.push(error)
      }
    }
    await rm(directory, { recursive: true, force: true })
    if (errors.length)
      throw new AggregateError(
        errors,
        "Exact owned-container cleanup failed; inspect logged fixture IDs"
      )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", interrupt)
  try {
    await runUserScanSlotRuntime({ reportPath: process.argv[2], signal: controller.signal })
  } finally {
    process.removeListener("SIGINT", interrupt)
    process.removeListener("SIGTERM", interrupt)
  }
}
