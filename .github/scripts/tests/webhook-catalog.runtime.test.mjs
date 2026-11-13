import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { gunzipSync } from "node:zlib"

const require = createRequire(new URL("../../../packages/db/package.json", import.meta.url))
const { PrismaClient } = require("./src/generated/prisma")
const { PrismaPg } = require("@prisma/adapter-pg")
const { Pool } = require("pg")

const verifierSource = readFileSync(
  new URL("../verify-webhook-cutover.mjs", import.meta.url),
  "utf8"
)
const migrationNamesMatch = verifierSource.match(
  /const migrationNames = (\[[\s\S]*?\])\nconst firstMigrationNames/
)
assert.ok(migrationNamesMatch, "the verifier must declare its worker migration set")
const migrationNames = JSON.parse(migrationNamesMatch[1].replace(/,\s*\]/g, "]"))
const probeTemplateMatch = verifierSource.match(/const code = `([\s\S]*?)`\nconst script =/)
assert.ok(probeTemplateMatch, "the verifier must declare its embedded worker probe")
// Evaluate the trusted template exactly as the production script does, including
// its migrationNames interpolation; the returned string is the worker program.
const embeddedProbe = new Function("migrationNames", `return \`${probeTemplateMatch[1]}\``)(
  migrationNames
)
const constraintQueryMatch = embeddedProbe.match(
  /const constraints = await prisma\.\$queryRawUnsafe\(\s*"([^"]+)"/
)
assert.ok(constraintQueryMatch, "the embedded probe must query worker constraints")
const constraintQuery = JSON.parse(`"${constraintQueryMatch[1]}"`)

const legacyColumns = [
  ["id", "text", true, null],
  ["webhookEventId", "text", true, null],
  ["workspaceId", "text", false, null],
  ["track", "text", true, null],
  ["status", "text", true, "'pending'::text"],
  ["attempts", "integer", true, "0"],
  ["lastError", "text", false, null],
  ["completedAt", "timestamp(3) without time zone", false, null],
  ["createdAt", "timestamp(3) without time zone", true, "CURRENT_TIMESTAMP"],
  ["updatedAt", "timestamp(3) without time zone", true, null],
  ["generation", "integer", true, "0"],
  ["nextAttemptAt", "timestamp(3) without time zone", false, null],
  ["claimToken", "text", false, null],
  ["leaseExpiresAt", "timestamp(3) without time zone", false, null],
]
const currentColumns = [
  ...legacyColumns.map(([name, type, notNull, defaultExpr]) => [
    name,
    type,
    notNull,
    name === "nextAttemptAt" ? "CURRENT_TIMESTAMP" : defaultExpr,
  ]),
  ["nextAttemptAtUtc", "timestamp(3) with time zone", false, "CURRENT_TIMESTAMP"],
  ["leaseExpiresAtUtc", "timestamp(3) with time zone", false, null],
  ["historicalAttempts", "integer", true, "0"],
  ["operatorRecoveryCount", "integer", true, "0"],
]

const lowerUnquotedCatalogIdentifiers = new Set(["id", "generation"])
const normalizeCatalog = (value) => {
  const source = String(value ?? "")
  let normalized = ""
  let index = 0
  let pendingSpace = false

  const append = (token) => {
    if (pendingSpace && normalized) normalized += " "
    normalized += token
    pendingSpace = false
  }

  while (index < source.length) {
    if (/\s/.test(source[index])) {
      pendingSpace = true
      index += 1
      while (index < source.length && /\s/.test(source[index])) index += 1
      continue
    }

    const quote = source[index]
    if (quote === "'" || quote === '"') {
      const start = index
      index += 1
      let contents = ""
      let closed = false
      while (index < source.length) {
        if (source[index] === quote) {
          if (source[index + 1] === quote) {
            contents += quote
            index += 2
            continue
          }
          index += 1
          closed = true
          break
        }
        contents += source[index]
        index += 1
      }
      if (!closed) return `\u0000invalid-catalog-sql:${source}`

      if (quote === "'") {
        append(source.slice(start, index))
      } else if (
        lowerUnquotedCatalogIdentifiers.has(contents) &&
        /^[a-z_][a-z0-9_$]*$/.test(contents)
      ) {
        append(contents)
      } else {
        append(`"${contents.replaceAll('"', '""')}"`)
      }
      continue
    }

    const start = index
    while (
      index < source.length &&
      !/\s/.test(source[index]) &&
      source[index] !== "'" &&
      source[index] !== '"'
    ) {
      index += 1
    }
    append(source.slice(start, index).toLowerCase())
  }

  return normalized.trim()
}

function disposableConnectionString() {
  assert.equal(process.env.LYRASHIELD_TEST_DB_DISPOSABLE, "1")
  assert.ok(process.env.DATABASE_URL, "a disposable local DATABASE_URL is required")
  const target = new URL(process.env.DATABASE_URL)
  assert.ok(["postgres:", "postgresql:"].includes(target.protocol))
  assert.equal(target.port || "5432", "5432")
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))
  assert.equal(target.pathname, "/lyrashield")
  return target.href
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`
}

function migrationStatements(sql) {
  // These checked-in migrations use line comments and contain no quoted
  // semicolons. Remove comments before splitting so PGlite and native pg both
  // execute each DDL statement separately; this also keeps CONCURRENTLY outside
  // an implicit multi-statement transaction.
  return sql
    .replace(/--[^\r\n]*/g, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean)
}

async function createFixture(pool, fixtureNames, mode) {
  const suffix = randomBytes(8).toString("hex")
  const schema = `webhook_catalog_${suffix}`
  const role = `webhook_catalog_reader_${suffix}`
  fixtureNames.push({ schema, role })
  const quotedSchema = quoteIdentifier(schema)
  const quotedRole = quoteIdentifier(role)
  await pool.query(`CREATE SCHEMA ${quotedSchema}`)
  await pool.query(`SET search_path TO ${quotedSchema}, public`)
  await pool.query(
    'CREATE TABLE "WebhookEvent" ("id" TEXT NOT NULL, CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id"))'
  )
  await pool.query(
    'CREATE TABLE "_prisma_migrations" ("migration_name" TEXT NOT NULL, "checksum" TEXT NOT NULL, "finished_at" TIMESTAMPTZ, "rolled_back_at" TIMESTAMPTZ)'
  )

  const appliedMigrations = mode === "legacy" ? migrationNames.slice(0, 2) : migrationNames
  const migrationChecksums = new Map()
  for (const migrationName of appliedMigrations) {
    const migrationPath = new URL(
      `../../../packages/db/prisma/migrations/${migrationName}/migration.sql`,
      import.meta.url
    )
    const migrationSql = readFileSync(migrationPath, "utf8")
    for (const statement of migrationStatements(migrationSql)) await pool.query(statement)
    const checksum = createHash("sha256").update(migrationSql).digest("hex")
    migrationChecksums.set(migrationName, checksum)
    await pool.query(
      'INSERT INTO "_prisma_migrations" ("migration_name", "checksum", "finished_at", "rolled_back_at") VALUES ($1, $2, CURRENT_TIMESTAMP, NULL)',
      [migrationName, checksum]
    )
  }

  await pool.query(`CREATE ROLE ${quotedRole} NOSUPERUSER NOBYPASSRLS NOLOGIN`)
  await pool.query(`GRANT USAGE ON SCHEMA ${quotedSchema} TO ${quotedRole}`)
  await pool.query(
    `GRANT SELECT ON TABLE ${quotedSchema}."_prisma_migrations", ${quotedSchema}."WebhookEventTrack" TO ${quotedRole}`
  )
  await pool.query(`SET ROLE ${quotedRole}`)
  await pool.query(`SET search_path TO ${quotedSchema}, public`)

  const roleResult = await pool.query(
    "SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = current_user"
  )
  assert.deepEqual(roleResult.rows, [
    { rolname: role, rolsuper: false, rolbypassrls: false, rolcanlogin: false },
  ])

  return { schema, role, appliedMigrations, migrationChecksums }
}

function workerIdentity(mode) {
  const product = mode === "legacy" ? "4822306e24f375800981bf282fd992a9c15dcde8" : "a".repeat(40)
  const engine = mode === "legacy" ? "9d90be5aaf92f86bb5c1ba55a8138545764fdd44" : "b".repeat(40)
  const digest =
    mode === "legacy"
      ? "sha256:dbc43686e11f95a03d9f163c865683e3949ade4179839ef6d268e6ea55f9b78f"
      : `sha256:${"c".repeat(64)}`
  const image = `ghcr.io/example/worker:${product}@${digest}`
  return { product, engine, digest, image }
}

async function assertOriginalConstraintTypeRejected(prismaClient, fixture) {
  const originalSql = constraintQuery.replace("contype::text AS type", "contype AS type")
  assert.notEqual(
    originalSql,
    constraintQuery,
    "the production query must cast catalog char to text"
  )
  await assert.rejects(
    prismaClient.$queryRawUnsafe(originalSql, fixture.schema, "WebhookEventTrack"),
    (error) =>
      error.code === "P2010" &&
      error.meta?.driverAdapterError?.cause?.kind === "UnsupportedNativeDataType" &&
      error.meta?.driverAdapterError?.cause?.type === "char"
  )
}

async function executeEmbeddedProbe(prismaClient, fixture, mode) {
  const identity = workerIdentity(mode)
  const queries = []
  let disconnectCount = 0
  const prisma = new Proxy(prismaClient, {
    get(target, property) {
      if (property === "$queryRawUnsafe")
        return async (sql, ...args) => {
          queries.push({ sql, args })
          return await target.$queryRawUnsafe(sql, ...args)
        }
      if (property === "$disconnect")
        return async () => {
          disconnectCount += 1
          return await target.$disconnect()
        }
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  const importShim = async (name) => {
    if (name === "node:zlib") return import("node:zlib")
    if (name === "@lyrashield/billing") {
      return {
        WEBHOOK_TRACK_CLAIM_PROTOCOL: mode === "legacy" ? "durable-claims/1" : "durable-claims/2",
      }
    }
    if (name === "@lyrashield/db") return { getSystemPrisma: () => prisma }
    throw new Error(`Unexpected embedded probe import: ${name}`)
  }
  const isolatedProcess = {
    argv: [process.execPath, identity.image, identity.image, identity.product, identity.engine],
    env: {
      LYRASHIELD_PRODUCT_REVISION: identity.product,
      LYRASHIELD_WORKER_IMAGE_DIGEST: identity.digest,
      LYRASHIELD_ENGINE_REVISION: identity.engine,
    },
    exitCode: undefined,
  }
  const output = { stdout: [], stderr: [] }
  const isolatedConsole = {
    log: (...values) => output.stdout.push(values.join(" ")),
    error: (...values) => output.stderr.push(values.join(" ")),
  }
  const executableProbe = embeddedProbe.replaceAll("import(", "load(")
  const evaluateProbe = new Function(
    "load",
    "process",
    "console",
    `return (async () => { ${executableProbe}\n })()`
  )
  await evaluateProbe(importShim, isolatedProcess, isolatedConsole)
  assert.equal(disconnectCount, 1, `${mode} probe must disconnect its Prisma client`)
  return { identity, queries, output, exitCode: isolatedProcess.exitCode }
}

function decodeProbeFrame(result, mode) {
  assert.equal(
    result.exitCode,
    undefined,
    `${mode}: worker set a failing exit code: ${result.output.stderr}`
  )
  assert.deepEqual(result.output.stderr, [], `${mode}: worker probe emitted an error phase`)
  const marker = "WEBHOOK_WORKER_STATE_GZIP_V1="
  const padding = `Azure Run Command prelude ${"0123456789abcdef".repeat(32)}\n`.repeat(80)
  const wrappedOutput = Buffer.from(
    `${padding}[stdout]\n${result.output.stdout.join("\n")}\n[stderr]\n${result.output.stderr.join("\n")}\n`
  )
  assert.ok(
    wrappedOutput.byteLength > 4096,
    `${mode}: test wrapper must exceed Azure's tail budget`
  )
  const retainedResponse = wrappedOutput.subarray(-4096).toString("utf8")
  assert.equal(
    Buffer.byteLength(retainedResponse),
    4096,
    `${mode}: expected Azure's 4096-byte tail`
  )
  const stdoutStart = retainedResponse.lastIndexOf("[stdout]\n")
  const stderrStart = retainedResponse.indexOf("\n[stderr]\n", stdoutStart)
  assert.ok(
    stdoutStart >= 0 && stderrStart > stdoutStart,
    `${mode}: Azure stream wrapper was truncated`
  )
  const wrappedStdout = retainedResponse.slice(stdoutStart + "[stdout]\n".length, stderrStart)
  const frameLines = wrappedStdout.split("\n").filter((line) => line.startsWith(marker))
  assert.equal(frameLines.length, 1, `${mode}: expected one worker state frame in Azure stdout`)
  const frame = frameLines[0]
  assert.ok(frame.startsWith(marker), `${mode}: missing worker state frame`)
  assert.ok(
    Buffer.byteLength(frame) <= 3500,
    `${mode}: worker frame exceeded Azure's output budget`
  )
  const encoded = frame.slice(marker.length)
  const compressed = Buffer.from(encoded, "base64")
  assert.ok(
    encoded && compressed.toString("base64") === encoded,
    `${mode}: noncanonical base64 frame`
  )
  const uncompressed = gunzipSync(compressed, { maxOutputLength: 65536 })
  assert.ok(uncompressed.byteLength <= 65536, `${mode}: decoded state exceeded its bound`)
  const state = JSON.parse(uncompressed.toString("utf8"))
  assert.equal(state.version, 1, `${mode}: unexpected frame version`)
  return state
}

function assertProbeQueries(queries, fixture) {
  assert.equal(queries.length, 5)
  assert.match(queries[0].sql, /SELECT current_schema\(\) AS schema/)
  assert.match(queries[1].sql, /FROM\s+"[^"]+"\."_prisma_migrations"/)
  assert.deepEqual(queries[1].args, migrationNames)
  assert.match(queries[2].sql, /FROM pg_attribute a/)
  assert.match(queries[3].sql, /contype::text AS type/)
  assert.match(queries[3].sql, /pg_get_constraintdef\(oid, true\) AS definition/)
  assert.doesNotMatch(queries[3].sql, /lower\s*\(\s*pg_get_constraintdef/i)
  assert.match(queries[3].sql, /FROM pg_constraint/)
  assert.match(queries[4].sql, /FROM pg_index ix/)
  for (const query of queries.slice(2)) {
    assert.deepEqual(query.args, [fixture.schema, "WebhookEventTrack"])
  }
}

function assertProbeState(state, fixture, mode, identity) {
  const expectedProtocol = mode === "legacy" ? "durable-claims/1" : "durable-claims/2"
  assert.equal(state.schema, fixture.schema)
  assert.equal(state.protocol, expectedProtocol)
  assert.equal(state.product, identity.product)
  assert.equal(state.engine, identity.engine)
  assert.equal(state.digest, identity.digest)
  assert.deepEqual(state.readback, {
    WORKER_ROLLBACK_IMAGE: identity.image,
    WORKER_IMAGE: identity.image,
    WORKER_PRODUCT: identity.product,
    WORKER_ENGINE: identity.engine,
  })

  const migrationRows = state.migrationRows
    .map((row) => [row.migration_name, row.checksum, row.finished_at !== null, row.rolled_back_at])
    .sort(([left], [right]) => left.localeCompare(right))
  assert.deepEqual(
    migrationRows,
    fixture.appliedMigrations
      .map((name) => [name, fixture.migrationChecksums.get(name), true, null])
      .sort(([left], [right]) => left.localeCompare(right))
  )

  const expectedColumns = mode === "legacy" ? legacyColumns : currentColumns
  assert.deepEqual(
    state.columns.map((column) => [column.name, column.type, column.notNull, column.defaultExpr]),
    expectedColumns
  )

  const constraintRows = state.constraints
    .map((row) => [row.name, row.type, normalizeCatalog(row.definition), row.validated])
    .sort(([left], [right]) => left.localeCompare(right))
  const foreignKey = state.constraints.find(
    (constraint) => constraint.name === "WebhookEventTrack_webhookEventId_fkey"
  )
  assert.equal(
    foreignKey?.definition,
    'FOREIGN KEY ("webhookEventId") REFERENCES "WebhookEvent"(id) ON UPDATE CASCADE ON DELETE CASCADE'
  )
  assert.deepEqual(constraintRows, [
    ["WebhookEventTrack_generation_nonnegative", "c", "check (generation >= 0)", true],
    ["WebhookEventTrack_pkey", "p", "primary key (id)", true],
    [
      "WebhookEventTrack_webhookEventId_fkey",
      "f",
      'foreign key ("webhookEventId") references "WebhookEvent"(id) on update cascade on delete cascade',
      true,
    ],
  ])

  const expectedIndexes = [
    ["WebhookEventTrack_pkey", true, ["id"]],
    ["WebhookEventTrack_status_idx", false, ["status"]],
    ["WebhookEventTrack_status_nextAttemptAt_idx", false, ["status", "nextAttemptAt"]],
    ["WebhookEventTrack_track_status_idx", false, ["track", "status"]],
    ["WebhookEventTrack_webhookEventId_track_key", true, ["webhookEventId", "track"]],
  ]
  if (mode === "current") {
    expectedIndexes.push([
      "WebhookEventTrack_status_nextAttemptAtUtc_idx",
      false,
      ["status", "nextAttemptAtUtc"],
    ])
  }
  const indexRows = state.indexes
    .map((index) => [
      index.name,
      index.unique,
      index.valid,
      index.ready,
      index.predicateIsNull,
      index.noIncludeColumns,
      index.noExpressions,
      index.method,
      index.columns,
      index.defaultOrdering,
      index.defaultOperatorClasses,
      index.columnCollationsMatch,
    ])
    .sort(([left], [right]) => left.localeCompare(right))
  const expectedIndexRows = expectedIndexes
    .map(([name, unique, columns]) => [
      name,
      unique,
      true,
      true,
      true,
      true,
      true,
      "btree",
      columns,
      columns.map(() => true),
      columns.map(() => true),
      columns.map(() => true),
    ])
    .sort(([left], [right]) => left.localeCompare(right))
  assert.deepEqual(indexRows, expectedIndexRows)
}

for (const mode of ["legacy", "current"]) {
  test(`embedded worker catalog probe succeeds under a restricted role for ${mode} migrations`, async (t) => {
    const connectionString = disposableConnectionString()
    const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 })
    const prismaClient = new PrismaClient({ adapter: new PrismaPg(pool) })
    const fixtures = []
    t.after(async () => {
      const cleanupErrors = []
      for (const fixture of fixtures) {
        try {
          await pool.query("RESET ROLE")
        } catch {}
        try {
          await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(fixture.schema)} CASCADE`)
        } catch (error) {
          cleanupErrors.push(error)
        }
        try {
          await pool.query(`DROP ROLE IF EXISTS ${quoteIdentifier(fixture.role)}`)
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      try {
        await prismaClient.$disconnect()
      } catch (error) {
        cleanupErrors.push(error)
      }
      await pool.end()
      if (cleanupErrors.length)
        throw new AggregateError(cleanupErrors, "catalog fixture cleanup failed")
    })

    const fixture = await createFixture(pool, fixtures, mode)
    await assertOriginalConstraintTypeRejected(prismaClient, fixture)
    const result = await executeEmbeddedProbe(prismaClient, fixture, mode)
    const state = decodeProbeFrame(result, mode)
    assertProbeQueries(result.queries, fixture)
    assertProbeState(state, fixture, mode, result.identity)
  })
}
