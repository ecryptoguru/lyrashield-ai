// Protected-workflow controller. All subprocess output is captured privately;
// service errors, credentials and catalog identities never enter Actions logs.
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { readFileSync, writeFileSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runFirstV26Phase } from "./v26-cutover-orchestration.mjs"
import { classifyV26Schema } from "./v26-schema-classifier.mjs"
import { collectLegacyAccountingDiagnostic } from "./v26-accounting-diagnostic.mjs"
import { collectV26PostMigrationReadback } from "./v26-post-migration-readback.mjs"
import {
  observeRuntimeDatabase,
  fingerprint,
  grantV26RuntimeTables,
  assertNoAdjacentExecutions,
} from "./v26-runtime-database.mjs"

const require = createRequire(new URL("../../packages/db/package.json", import.meta.url))
const { Client } = require("pg")
const env = process.env
const command = process.argv[2]
const statePath = join(env.RUNNER_TEMP || tmpdir(), "lyrashield-v26-controller.json")
const migrations = [
  "20261030103000_scan_admission_capacity",
  "20261030103100_scan_accounting_release",
  "20261030104500_fix_pr_execution_identity",
  "20261030110000_schedule_admission",
].map((name) => ({
  name,
  checksum: fingerprint(
    // These paths are source-controlled modules or private runner/VM receipt paths.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    readFileSync(
      new URL(`../../packages/db/prisma/migrations/${name}/migration.sql`, import.meta.url)
    )
  ),
}))
const shellQuote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'"
function execute(file, args, timeout = 120000) {
  try {
    return execFileSync(file, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    })
  } catch {
    throw new Error("v26 authoritative service operation failed")
  }
}
const az = (args) => execute("az", [...args, "--only-show-errors", "--output", "json"])
const azure = (args) => JSON.parse(az(args))
// These paths are source-controlled modules or private runner/VM receipt paths.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const save = (state) => writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 })
// These paths are source-controlled modules or private runner/VM receipt paths.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const load = () => JSON.parse(readFileSync(statePath, "utf8"))
function output(key, value) {
  // These paths are source-controlled modules or private runner/VM receipt paths.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `${key}=${value}\n`)
}
function configured() {
  for (const key of ["DEPLOY_SHA", "ENGINE_REVISION"])
    if (!/^[a-f0-9]{40}$/.test(env[key] ?? "")) throw new Error("v26 source identity missing")
  for (const key of ["WEB_DIGEST", "WORKER_DIGEST"])
    if (!/^sha256:[a-f0-9]{64}$/.test(env[key] ?? "")) throw new Error("v26 image identity missing")
  for (const key of ["RG", "APP_NAME", "SCANNER_NAME", "WORKER_VM_NAME"])
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(env[key] ?? ""))
      throw new Error("v26 fleet configuration missing")
  if (!env.DATABASE_DIRECT_URL || !env.BULLMQ_REDIS_URL)
    throw new Error("v26 connection configuration missing")
}
async function connected(url, callback) {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 10000,
    query_timeout: 15000,
  })
  try {
    await client.connect()
    return await callback(client)
  } finally {
    await client.end().catch(() => {})
  }
}
function vm(action, request, extra = {}) {
  const files = [
    "v26-vm.sh",
    "v26-vm-state.mjs",
    "v26-durable-state.mjs",
    "v26-cutover-receipt.mjs",
    "v26-runtime-database.mjs",
    "v26-execution-drain.sh",
  ]
  let script =
    "set -eu; directory=$(mktemp -d /var/lib/lyrashield/v26-run.XXXXXX); trap 'rm -rf \"$directory\"' EXIT; "
  for (const name of files) {
    // These paths are source-controlled modules or private runner/VM receipt paths.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const payload = readFileSync(new URL(name, import.meta.url)).toString("base64")
    script += `printf %s '${payload}' | base64 -d > "$directory/${name}"; `
  }
  // These paths are source-controlled modules or private runner/VM receipt paths.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  script += `printf %s '${readFileSync(new URL("../../ops/worker/worker-env.sh", import.meta.url)).toString("base64")}' | base64 -d > "$directory/worker-env.sh"; `
  script += `sh "$directory/v26-vm.sh" ${shellQuote(action)} '${Buffer.from(JSON.stringify(request)).toString("base64")}' '${Buffer.from(JSON.stringify(extra)).toString("base64")}'`
  const result = azure([
    "vm",
    "run-command",
    "invoke",
    "--name",
    env.WORKER_VM_NAME,
    "--resource-group",
    env.RG,
    "--command-id",
    "RunShellScript",
    "--scripts",
    script,
  ])
  const message = result.value?.[0]?.message
  if (
    typeof message !== "string" ||
    !message.split(/\r?\n/).includes(`V26_PHASE_OK=${action === "stop" ? "quiesced" : action}`)
  )
    throw new Error("v26 VM acknowledgement unavailable")
  if (action === "probe") {
    const markers = message.split(/\r?\n/).filter((line) => line.startsWith("V26_PRIVATE="))
    const images = message.split(/\r?\n/).filter((line) => line.startsWith("V26_WORKER_IMAGE="))
    if (markers.length !== 1 || images.length !== 1)
      throw new Error("v26 VM observation incomplete")
    return {
      ...JSON.parse(Buffer.from(markers[0].slice(12), "base64").toString()),
      workerImage: images[0].slice(17),
    }
  }
}
function imageIdentity(image, reservationAware) {
  const [reference, digest, ...extra] = String(image).split("@")
  const [repository, tag, ...extraTag] = reference.split(":")
  if (
    extra.length !== 0 ||
    extraTag.length !== 0 ||
    !/^ghcr\.io\/ecryptoguru\/lyrashield-ai\/lyrashield-(web|worker)$/.test(repository) ||
    !/^sha256:[a-f0-9]{64}$/.test(digest ?? "") ||
    (tag !== undefined && !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag))
  )
    throw new Error("v26 unpinned writer image")
  execute("docker", ["pull", image], 900000)
  const [metadata] = JSON.parse(execute("docker", ["image", "inspect", image]))
  const labels = metadata?.Config?.Labels
  if (!/^[a-f0-9]{40}$/.test(labels?.["org.opencontainers.image.revision"] ?? ""))
    throw new Error("v26 writer source unavailable")
  const protocol = labels?.["io.lyrashield.accounting.protocol"]
  if (reservationAware ? protocol !== "reservations/2" : protocol === "reservations/2")
    throw new Error("v26 schema/writer capability mismatch")
  return { image, sourceRevision: labels["org.opencontainers.image.revision"] }
}
function revisions(name) {
  const list = azure([
    "containerapp",
    "revision",
    "list",
    "--name",
    name,
    "--resource-group",
    env.RG,
  ])
  if (
    !Array.isArray(list) ||
    list.length === 0 ||
    list.some(
      (row) =>
        typeof row?.name !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(row.name) ||
        typeof row?.properties?.active !== "boolean"
    )
  )
    throw new Error("v26 writer inventory unavailable")
  return list
}
async function observeFleet(databaseIdentity, current, held) {
  const fleet = [],
    principals = []
  for (const name of [env.APP_NAME, env.SCANNER_NAME]) {
    const inventory = revisions(name)
    const active = inventory.filter((row) => row.properties.active)
    if (!held && active.length === 0) throw new Error("v26 writer baseline missing")
    const template = azure(["containerapp", "show", "--name", name, "--resource-group", env.RG])
      .properties?.template
    const secrets = azure([
      "containerapp",
      "secret",
      "list",
      "--name",
      name,
      "--resource-group",
      env.RG,
      "--show-values",
    ])
    for (const row of active.length ? active : [{ name: "held", properties: { template } }]) {
      const containers = row.properties?.template?.containers
      if (!Array.isArray(containers) || containers.length !== 1)
        throw new Error("v26 unknown writer topology")
      const runtime = containers[0]
      const ref = runtime.env?.filter((value) => value.name === "DATABASE_URL")
      if (ref?.length !== 1 || !ref[0].secretRef)
        throw new Error("v26 runtime connection reference unavailable")
      const secret = secrets.filter((value) => value.name === ref[0].secretRef)
      if (secret.length !== 1 || typeof secret[0].value !== "string" || !secret[0].value)
        throw new Error("v26 runtime secret resolution unavailable")
      const observed = await connected(secret[0].value, (client) => observeRuntimeDatabase(client))
      if (observed.databaseIdentity !== databaseIdentity)
        throw new Error("v26 runtime/migration database differs")
      principals.push(observed.principal)
      const identity = imageIdentity(runtime.image, current)
      fleet.push({
        name,
        revision: row.name,
        ...identity,
        principal: observed.principal,
        databaseUrlSha256: fingerprint(secret[0].value),
      })
    }
  }
  return { fleet, principals: [...new Set(principals)] }
}
function assertInactive() {
  for (const name of [env.APP_NAME, env.SCANNER_NAME])
    for (const row of revisions(name)) {
      if (row.properties.active) throw new Error("v26 old producer remains active")
      const replicas = azure([
        "containerapp",
        "replica",
        "list",
        "--name",
        name,
        "--resource-group",
        env.RG,
        "--revision",
        row.name,
      ])
      if (!Array.isArray(replicas) || replicas.length !== 0)
        throw new Error("v26 old producer replicas remain")
    }
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function deactivate() {
  for (const name of [env.APP_NAME, env.SCANNER_NAME])
    for (const row of revisions(name).filter((row) => row.properties.active))
      azure([
        "containerapp",
        "revision",
        "deactivate",
        "--name",
        name,
        "--resource-group",
        env.RG,
        "--revision",
        row.name,
      ])
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      assertInactive()
      return
    } catch (error) {
      if (attempt === 11) throw error
      await pause(5000)
    }
  }
}
async function inventory(client) {
  await assertNoAdjacentExecutions(client)
  const diagnostic = await collectLegacyAccountingDiagnostic(client)
  if (diagnostic.status !== "NO_DETECTED_DB_BLOCKERS")
    throw new Error("v26 global accounting inventory requires review")
  return fingerprint(JSON.stringify(diagnostic))
}
async function checkMigrated(client, state) {
  await assertNoAdjacentExecutions(client)
  if ((await classifyV26Schema(client, migrations)) !== "current")
    throw new Error("v26 migration incomplete")
  const result = await collectV26PostMigrationReadback(client, {
    principals: state.principals,
    migrations,
  })
  if (result.status !== "NO_DETECTED_DB_BLOCKERS")
    throw new Error("v26 migration, grants, RLS or seeds require review")
  return fingerprint(
    JSON.stringify({ migrations, result, principals: state.principals.map(fingerprint) })
  )
}
async function assertCandidateFleet(state) {
  for (const name of [env.APP_NAME, env.SCANNER_NAME]) {
    const inventory = revisions(name)
    const active = inventory.filter((row) => row.properties.active)
    if (
      active.length !== 1 ||
      active[0].properties.template?.containers?.length !== 1 ||
      active[0].properties.template.containers[0].image !== state.webImage
    )
      throw new Error("v26 candidate fleet image mismatch")
    for (const row of inventory.filter((row) => !row.properties.active)) {
      const replicas = azure([
        "containerapp",
        "replica",
        "list",
        "--name",
        name,
        "--resource-group",
        env.RG,
        "--revision",
        row.name,
      ])
      if (!Array.isArray(replicas) || replicas.length) throw new Error("v26 old replica remains")
    }
    const traffic = azure([
      "containerapp",
      "ingress",
      "traffic",
      "show",
      "--name",
      name,
      "--resource-group",
      env.RG,
    ])
    const weighted = traffic.filter((row) => Number(row.weight) > 0)
    if (
      weighted.length !== 1 ||
      weighted[0].revisionName !== active[0].name ||
      weighted[0].latestRevision === true ||
      Number(weighted[0].weight) !== 100
    )
      throw new Error("v26 candidate traffic mismatch")
  }
  const fresh = await observeFleet(state.request.databaseIdentity, true, false)
  if (
    JSON.stringify([...fresh.principals].sort()) !== JSON.stringify([...state.appPrincipals].sort())
  )
    throw new Error("v26 runtime principals changed during cutover")
  for (const url of [env.APP_URL, env.SCANNER_URL]) {
    const response = await fetch(`${url}/api/ready`, {
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    })
    if (
      response.status !== 200 ||
      response.headers.get("x-lyrashield-accounting-protocol") !== "reservations/2"
    )
      throw new Error("v26 candidate readiness unavailable")
  }
}

async function main() {
  configured()
  await connected(env.DATABASE_DIRECT_URL, async (client) => {
    if (command === "prepare") {
      const migration = await observeRuntimeDatabase(client, { runtime: false })
      const request = {
        runId: env.GITHUB_RUN_ID,
        attempt: Number(env.GITHUB_RUN_ATTEMPT),
        owner: `${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}`,
        sourceRevision: env.DEPLOY_SHA,
        engineRevision: env.ENGINE_REVISION,
        workerDigest: env.WORKER_DIGEST,
        webDigest: env.WEB_DIGEST,
        databaseIdentity: migration.databaseIdentity,
        redisIdentity: fingerprint(env.BULLMQ_REDIS_URL),
      }
      const live = vm("probe", request)
      if (
        live.worker.databaseIdentity !== migration.databaseIdentity ||
        live.worker.redisUrlSha256 !== request.redisIdentity
      )
        throw new Error("v26 worker/migration connection mismatch")
      if (live.receipt && live.receipt.phase !== "COMPLETE")
        throw new Error("Incomplete first-v26 cutover requires deliberate operator repair")
      const schema = await classifyV26Schema(client, migrations)
      const current = schema === "current"
      if (
        !current &&
        (Number(env.GITHUB_RUN_ATTEMPT) !== 1 || env.WEBHOOK_CLAIMS_CUTOVER === "true")
      )
        throw new Error("First-v26 transition requires a fresh compatible-webhook release")
      const held = false
      const observed = await observeFleet(migration.databaseIdentity, current && !held, held)
      imageIdentity(live.workerImage, current && !held)
      const webImage = `${env.WEB_IMAGE.split("@")[0]}@${env.WEB_DIGEST}`
      const workerImage = `${env.WORKER_IMAGE.split("@")[0]}@${env.WORKER_DIGEST}`
      execute(
        "sh",
        [
          ".github/scripts/verify-v26-images.sh",
          webImage,
          workerImage,
          env.DEPLOY_SHA,
          env.ENGINE_REVISION,
        ],
        1800000
      )
      const state = {
        request,
        schema,
        webImage,
        workerImage,
        principals: [...new Set([...observed.principals, live.worker.principal])],
        appPrincipals: observed.principals,
        baseline: {
          ...observed,
          worker: live.worker,
          workerImage: live.workerImage,
          claimEpoch: Math.floor(Date.now() / 1000),
        },
        held,
      }
      save(state)
      output("V26_CUTOVER", schema === "legacy" ? "true" : "false")
      // Current-schema ordinary releases may roll back only to the capability-
      // verified active fleet and worker just observed above.
      console.log(`v26 release mode: ${schema === "legacy" ? "maintenance" : "compatible"}`)
      return
    }
    const state = load()
    if (
      state.request.sourceRevision !== env.DEPLOY_SHA ||
      state.request.runId !== env.GITHUB_RUN_ID
    )
      throw new Error("v26 controller invocation changed")
    let accountingChecksum, postMigrationChecksum
    await runFirstV26Phase(command, {
      claim: () => vm("claim", state.request, state.baseline),
      owned: () => vm("owned", state.request),
      deactivate,
      inactive: assertInactive,
      async drain() {
        // Keep the old worker alive while admitted work finishes naturally.
        // Ten minutes is a maintenance bound, never an age-based release proof.
        for (let attempt = 0; attempt < 60; attempt++) {
          try {
            await inventory(client)
            vm("queues", state.request)
            return
          } catch (error) {
            if (attempt === 59) throw error
            await pause(10000)
          }
        }
      },
      stop: () => vm("stop", state.request),
      quiesced: () => vm("quiesced", state.request),
      async inventory() {
        vm("inventory", state.request, { accountingChecksum: await inventory(client) })
      },
      async legacySchema() {
        if ((await classifyV26Schema(client, migrations)) !== "legacy")
          throw new Error("Uncertain first migration requires operator repair")
      },
      async accounting() {
        accountingChecksum = await inventory(client)
      },
      migrationIntent: () =>
        vm("migration-intent", state.request, { migrations, accountingChecksum }),
      grant: () => grantV26RuntimeTables(client, state.principals),
      async postMigration() {
        postMigrationChecksum = await checkMigrated(client, state)
      },
      migrated: () => vm("migrated", state.request, { postMigrationChecksum }),
      candidateFleet: () => assertCandidateFleet(state),
      verified: () => vm("verify", state.request, { postMigrationChecksum }),
      release: () => vm("release", state.request),
    })
    console.log(`v26 controller phase passed: ${command}`)
  })
}
main().catch(() => {
  console.error(
    "v26 safeguard failed; no rollback performed; inspect the original receipt and repair deliberately"
  )
  process.exitCode = 1
})
