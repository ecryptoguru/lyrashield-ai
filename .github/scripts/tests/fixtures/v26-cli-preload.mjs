// Test-only boundary adapters. Both actual CLI programs and all their real
// collectors/state transitions run unchanged; only pg, Redis, Azure, Docker,
// and public HTTP responses are simulated in this disposable directory.
import fs from "node:fs"
import child from "node:child_process"
import Module, { syncBuiltinESMExports } from "node:module"
import { createHash } from "node:crypto"
import { join } from "node:path"
const directory = process.env.V26_CLI_TEST_DIRECTORY
if (!directory) throw new Error("Disposable test directory required")
const read = fs.readFileSync.bind(fs),
  write = fs.writeFileSync.bind(fs)
const stateFile = join(directory, "platform.json")
const state = () => JSON.parse(read(stateFile, "utf8"))
const save = (value) => write(stateFile, JSON.stringify(value))
const hash = (value) =>
  createHash("sha256")
    .update(value ?? "")
    .digest("hex")
const rows = (values) => ({ rows: values })
const principal = (url) => new URL(url).username
const expectedMigrations = () =>
  [
    "20261030103000_scan_admission_capacity",
    "20261030103100_scan_accounting_release",
    "20261030104500_fix_pr_execution_identity",
    "20261030110000_schedule_admission",
  ].map((name) => ({
    migration_name: name,
    checksum: hash(read(`packages/db/prisma/migrations/${name}/migration.sql`)),
    finished: true,
    rolled_back: false,
  }))
class Client {
  constructor(options) {
    this.role = principal(options.connectionString)
  }
  async connect() {}
  async end() {}
  async query(sql, args = []) {
    const s = state()
    if (sql.includes("current_user AS principal"))
      return rows([
        {
          principal: this.role,
          database: "fixture",
          database_oid: "123",
          server: "127.0.0.1",
          schema: "public",
          rolsuper: this.role === "migration",
          rolbypassrls: false,
        },
      ])
    if (sql.includes("global_read")) return rows([{ global_read: true }])
    if (sql.includes("transaction_read_only"))
      return rows([
        {
          rolsuper: true,
          rolbypassrls: false,
          read_only: "on",
          isolation: "repeatable read",
          row_security: "off",
        },
      ])
    if (sql.includes(" AS slot,"))
      return rows([{ slot: s.schema, capacity: s.schema, version: s.schema, settled: s.schema }])
    if (sql.includes("slot_present"))
      return rows([{ slot_present: false, reservation_present: false }])
    if (sql.includes("_prisma_migrations")) return rows(s.schema ? expectedMigrations() : [])
    if (sql.includes("AS approvals"))
      return rows([{ approvals: "0", operations: "0", webhook_tracks: "0" }])
    if (sql.includes(" AS type_name")) {
      const tables = {
        Scan: {
          id: "text",
          workspaceId: "text",
          createdById: "text",
          sponsorAccountId: "text",
          status: "ScanStatus",
          startedAt: "timestamp",
          endedAt: "timestamp",
          finalizationStartedAt: "timestamp",
          deletedAt: "timestamp",
        },
        ScanEvent: {
          id: "text",
          scanId: "text",
          stage: "text",
          metadata: "jsonb",
          deletedAt: "timestamp",
        },
        UsageRecord: {
          id: "text",
          workspaceId: "text",
          accountId: "text",
          kind: "text",
          idempotencyKey: "text",
          deletedAt: "timestamp",
          metadata: "jsonb",
        },
      }
      return rows(
        Object.entries(tables).flatMap(([table_name, fields]) =>
          Object.entries(fields).map(([column_name, type_name]) => ({
            table_name,
            column_name,
            type_name,
          }))
        )
      )
    }
    if (sql.includes("format_type"))
      return rows(
        Object.entries({
          "Scan.accountingVersion": "integer",
          "Scan.accountingSettledAt": "timestamp(3) without time zone",
          "PullRequest.executionKey": "text",
          "PullRequest.baseCommit": "text",
          "PullRequest.diffChecksum": "text",
          "PullRequest.approvalId": "text",
          "PullRequest.requestedById": "text",
          "PullRequest.credentialActor": "jsonb",
          "Schedule.lastScanId": "text",
          "Schedule.lastBlockedAt": "timestamp(3) without time zone",
          "Schedule.lastBlockedReason": "character varying(64)",
        }).map(([path, data_type]) => ({
          table_name: path.split(".")[0],
          column_name: path.split(".")[1],
          data_type,
        }))
      )
    if (sql.includes("pg_catalog.pg_index"))
      return rows([
        {
          indisunique: true,
          indisvalid: true,
          indisready: true,
          nonpartial: true,
          definition:
            'CREATE UNIQUE INDEX "PullRequest_executionKey_key" ON public."PullRequest" USING btree ("executionKey")',
        },
      ])
    if (sql.includes("pg_catalog.pg_policy"))
      return rows(
        [
          ["UserScanSlot", "user_scan_slot_owner", "userId", "app.current_scan_user_id"],
          [
            "ScanCapacityReservation",
            "scan_capacity_account_owner",
            "accountId",
            "app.current_account_id",
          ],
        ].map(([relname, polname, id, setting]) => ({
          relname,
          polname,
          relrowsecurity: true,
          relforcerowsecurity: true,
          polcmd: "*",
          polpermissive: true,
          roles: "{0}",
          using_expression: `("${id}" = NULLIF(current_setting('${setting}'::text, true), ''::text))`,
          check_expression: `("${id}" = NULLIF(current_setting('${setting}'::text, true), ''::text))`,
        }))
      )
    if (sql.includes("has_table_privilege"))
      return rows(
        args[0].map((rolname) => ({
          rolname,
          rolsuper: false,
          rolbypassrls: false,
          crud: s.grants,
        }))
      )
    if (sql.includes("AS slots")) return rows([{ slots: "0", reservations: "0" }])
    if (sql.startsWith("SELECT rolname"))
      return rows(args[0].map((rolname) => ({ rolname, rolsuper: false, rolbypassrls: false })))
    if (sql.startsWith("GRANT ")) {
      s.grants = true
      s.grantedSql.push(sql)
      save(s)
    }
    return rows([])
  }
}
class Redis {
  async get() {
    return state().stop
  }
  async set(_key, value) {
    const s = state()
    if (s.stop !== null) return null
    s.stop = value
    save(s)
    return "OK"
  }
  eval = async (_lua, _count, _key, value) => {
    const s = state()
    if (s.stop !== value) return 0
    s.stop = null
    s.released = true
    save(s)
    if (s.failure === "cas-ack-loss") throw new Error("lost release reply")
    return 1
  }
  async llen() {
    return 0
  }
  async zcard() {
    return 0
  }
  async quit() {}
}
const originalLoad = Module._load,
  originalResolve = Module._resolveFilename
Module._load = function (name, ...args) {
  if (name === "pg") return { Client }
  if (name === "ioredis") return Redis
  return originalLoad.call(this, name, ...args)
}
Module._resolveFilename = function (name, ...args) {
  if (["@lyrashield/db", "@lyrashield/integrations", "@lyrashield/billing"].includes(name))
    return join(directory, "entrypoints.mjs")
  return originalResolve.call(this, name, ...args)
}
const mapPath = (path) =>
  typeof path === "string"
    ? path.replace(/^\/v26-state(?=\/|$)/, directory).replace(/^\/v26-stop(?=\/|$)/, directory)
    : path
for (const name of ["openSync", "readFileSync", "lstatSync", "renameSync"]) {
  const original = fs[name].bind(fs)
  fs[name] = function (...args) {
    args[0] = mapPath(args[0])
    if (name === "renameSync") args[1] = mapPath(args[1])
    const result = original(...args)
    if (name === "lstatSync" && String(args[0]).startsWith(directory)) result.uid = 0
    return result
  }
}
const originalFsync = fs.fsyncSync.bind(fs)
fs.fsyncSync = function (fd) {
  if (state().released && state().failure === "completion-fsync")
    throw new Error("final fsync unavailable")
  return originalFsync(fd)
}
const originalExec = child.execFileSync
child.execFileSync = function (file, args, options) {
  const s = state()
  if (file === "sh" && args[0].endsWith("verify-v26-images.sh")) {
    if (s.failure === "images") throw new Error("qualification failed")
    return "V26_IMAGES_QUALIFIED\n"
  }
  if (file === "docker") {
    if (args[0] === "pull") return ""
    if (args[0] === "image") {
      const image = args[2]
      const candidate =
        image.endsWith(process.env.WORKER_DIGEST) || image.endsWith(process.env.WEB_DIGEST)
      return JSON.stringify([
        {
          Config: {
            Labels: {
              "org.opencontainers.image.revision": candidate
                ? process.env.DEPLOY_SHA
                : "a".repeat(40),
              "io.lyrashield.accounting.protocol":
                candidate || s.schema ? "reservations/2" : undefined,
            },
          },
        },
      ])
    }
  }
  if (file !== "az") return originalExec.call(this, file, args, options)
  const get = (flag) => args[args.indexOf(flag) + 1]
  const app = get("--name")
  if (args[0] === "vm") {
    const matches = get("--scripts").match(/v26-vm\.sh" '([^']+)' '([^']+)' '([^']+)'$/)
    if (!matches) throw new Error("Unknown VM transport")
    let [, action, request, extra] = matches
    if (s.failure === action) throw new Error("simulated VM observation failure")
    if (action === "stop") {
      if (s.active) throw new Error("old replicas active")
      s.worker = false
      save(s)
      write(
        join(directory, "worker-stop-provenance.json"),
        JSON.stringify({
          imageReference: s.oldWorker,
          capturedAtEpochSeconds: Math.floor(Date.now() / 1000) + 1,
          databaseUrlSha256: hash(process.env.V26_WORKER_TEST_URL),
          databaseSystemUrlSha256: hash(""),
          redisUrlSha256: hash(process.env.BULLMQ_REDIS_URL),
        }),
        { mode: 0o600 }
      )
      action = "quiesced"
    }
    const result = child.spawnSync(
      process.execPath,
      [
        "--import",
        new URL(import.meta.url).pathname,
        ".github/scripts/v26-vm-state.mjs",
        action,
        request,
        extra,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: process.env.V26_WORKER_TEST_URL,
          REDIS_URL: process.env.BULLMQ_REDIS_URL,
          DATABASE_SYSTEM_URL: "",
          LYRASHIELD_PRODUCT_REVISION: s.candidate ? process.env.DEPLOY_SHA : "a".repeat(40),
          LYRASHIELD_ENGINE_REVISION: process.env.ENGINE_REVISION,
          LYRASHIELD_WORKER_IMAGE_DIGEST: s.candidate
            ? process.env.WORKER_DIGEST
            : s.oldWorker.split("@")[1],
        },
      }
    )
    if (result.status !== 0) throw new Error(`VM CLI failed: ${result.stderr}`)
    const message =
      result.stdout +
      (action === "probe"
        ? `V26_WORKER_IMAGE=${s.candidate ? process.env.WORKER_IMAGE + "@" + process.env.WORKER_DIGEST : s.oldWorker}\n`
        : "")
    if (action === "probe") {
      const latest = state()
      latest.lastProbeBytes = Buffer.byteLength(message)
      latest.lastProbeMarkerRetained = message.slice(-4096).includes("V26_PRIVATE=")
      save(latest)
    }
    // Azure Run Command returns only the final 4096 bytes, including on the
    // subsequent ordinary release after a completed receipt has grown.
    return JSON.stringify({ value: [{ message: message.slice(-4096) }] })
  }
  const runtime = {
    image: s.candidate ? process.env.WEB_IMAGE + "@" + process.env.WEB_DIGEST : s.oldWeb,
    env: [{ name: "DATABASE_URL", secretRef: "runtime-url" }],
  }
  if (args.includes("deactivate")) {
    s.active = false
    save(s)
    return "{}"
  }
  if (args.includes("revision") && args.includes("list"))
    return JSON.stringify([
      {
        name: `${app}-old1`,
        properties: {
          active: s.active && !s.candidate,
          template: { containers: [{ ...runtime, image: s.oldWeb }] },
        },
      },
      {
        name: `${app}-current`,
        properties: { active: s.active, template: { containers: [runtime] } },
      },
    ])
  if (args.includes("replica"))
    return JSON.stringify(s.active && get("--revision").endsWith("current") ? [{}] : [])
  if (args.includes("secret"))
    return JSON.stringify([{ name: "runtime-url", value: process.env.V26_APP_TEST_URL }])
  if (args.includes("traffic"))
    return JSON.stringify([{ revisionName: `${app}-current`, weight: 100 }])
  if (args.includes("show"))
    return JSON.stringify({ properties: { template: { containers: [runtime] } } })
  throw new Error("Unknown Azure operation")
}
globalThis.fetch = async () => ({
  status: state().failure === "readiness" ? 503 : 200,
  headers: new Headers({ "x-lyrashield-accounting-protocol": "reservations/2" }),
})
syncBuiltinESMExports()
