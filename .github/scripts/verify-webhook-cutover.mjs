import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"

const protocol = "durable-claims/2"
const firstProtocol = "durable-claims/1"
const firstWriterRevision = "4822306e24f375800981bf282fd992a9c15dcde8"
const firstEngineRevision = "9d90be5aaf92f86bb5c1ba55a8138545764fdd44"
const firstWriterDigest = "sha256:dbc43686e11f95a03d9f163c865683e3949ade4179839ef6d268e6ea55f9b78f"
const firstWorkerDigest = "sha256:d38f8b080ae62b88ba9c6273be76abff42adf5a86b831bde5b19f6d6fce466dc"
const migrationChecksums = {
  "20260822140000_webhook_event_tracks":
    "5c7e395649b47940d928e9cc498794a00c6ce73416a4aa0513eff64085c7208d",
  "20260930120000_webhook_track_claims":
    "4beec0acacf3b9ee007cfdb77ec227c5e416b89328600007d08e8b3bf43ed3a8",
  "20261002120000_webhook_track_due_db_default":
    "0b84609011c35ee62dd671dbf47c947156f6fc624718a98373fe6ee7ef91693f",
  "20261002130000_webhook_track_utc_schedule":
    "3cf195cc44af5abf48b55e93ec057142c4ca1079a2664c8602369fe816a78d97",
  "20261002130100_webhook_track_utc_schedule_index":
    "ebfa8c71735d3b13eafd7c9f1514f1f5e3672f42bf4fefc9710147375ae92439",
  "20261002130200_webhook_track_operator_recovery":
    "72cbfad72bc74f1a0201e240c26e82e735b30fceaaf675fec9b8d53af0b63d63",
}
const migrationNames = [
  "20260822140000_webhook_event_tracks",
  "20260930120000_webhook_track_claims",
  "20261002120000_webhook_track_due_db_default",
  "20261002130000_webhook_track_utc_schedule",
  "20261002130100_webhook_track_utc_schedule_index",
  "20261002130200_webhook_track_operator_recovery",
]
const firstMigrationNames = migrationNames.slice(0, 2)
const firstMigrationColumns = [
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
const transitionColumns = [
  ["nextAttemptAtUtc", "timestamp(3) with time zone", false, "CURRENT_TIMESTAMP"],
  ["leaseExpiresAtUtc", "timestamp(3) with time zone", false, null],
  ["historicalAttempts", "integer", true, "0"],
  ["operatorRecoveryCount", "integer", true, "0"],
]
const fullyMigratedColumns = firstMigrationColumns.map(([name, type, notNull, defaultExpr]) => [
  name,
  type,
  notNull,
  name === "nextAttemptAt" ? "CURRENT_TIMESTAMP" : defaultExpr,
])
const legacyIndexes = [
  { name: "WebhookEventTrack_pkey", columns: ["id"], unique: true, method: "btree" },
  {
    name: "WebhookEventTrack_webhookEventId_track_key",
    columns: ["webhookEventId", "track"],
    unique: true,
    method: "btree",
  },
  { name: "WebhookEventTrack_status_idx", columns: ["status"], unique: false, method: "btree" },
  {
    name: "WebhookEventTrack_track_status_idx",
    columns: ["track", "status"],
    unique: false,
    method: "btree",
  },
  {
    name: "WebhookEventTrack_status_nextAttemptAt_idx",
    columns: ["status", "nextAttemptAt"],
    unique: false,
    method: "btree",
  },
]
const fullyMigratedIndexes = [
  ...legacyIndexes,
  {
    name: "WebhookEventTrack_status_nextAttemptAtUtc_idx",
    columns: ["status", "nextAttemptAtUtc"],
    unique: false,
    method: "btree",
  },
]
const legacyConstraints = [
  { name: "WebhookEventTrack_pkey", type: "p", definition: "primary key (id)" },
  {
    name: "WebhookEventTrack_webhookEventId_fkey",
    type: "f",
    definition:
      'foreign key ("webhookEventId") references "WebhookEvent"(id) on update cascade on delete cascade',
  },
  {
    name: "WebhookEventTrack_generation_nonnegative",
    type: "c",
    definition: "check (generation >= 0)",
  },
]
const runbook =
  "https://github.com/ecryptoguru/lyrashield-ai/blob/main/docs/reviews/2026-09-30/webhook-production-cutover.md"
const fail = (message) => {
  throw new Error(`${message}. No deployment mode was selected. See ${runbook}.`)
}
const sha = /^[a-f0-9]{40}$/
const digest = /@sha256:[a-f0-9]{64}$/
const args = process.argv.slice(2)
let outputPath
let expectedMode
while (args.length) {
  const option = args.shift()
  if (option === "--github-output") {
    outputPath = args.shift()
    if (!outputPath) fail("Missing GitHub output path")
  } else if (option === "--expect-mode") {
    expectedMode = args.shift()
    if (!expectedMode) fail("Missing expected baseline mode")
  } else fail(`Unknown verifier option ${option}`)
}
if (expectedMode && !["compatible", "first-cutover"].includes(expectedMode))
  fail("Invalid expected baseline mode")

const run = (command, commandArgs) =>
  execFileSync(command, commandArgs, {
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 1024 * 1024,
  }).trim()
const json = (command, commandArgs) => JSON.parse(run(command, commandArgs))
const group = process.env.AZURE_RESOURCE_GROUP
const worker = process.env.AZURE_WORKER_VM_NAME
if (!process.env.AZURE_APP_CONTAINER_APP_NAME) fail("Missing app writer baseline")
if (!group || !worker) fail("Missing resource group or worker VM")
const topology = process.env.AZURE_WEBHOOK_WRITER_TOPOLOGY || "app-and-scanner"
if (!["app-and-scanner", "app-only"].includes(topology)) fail("Unknown webhook writer topology")
if (topology === "app-and-scanner" && !process.env.AZURE_SCANNER_CONTAINER_APP_NAME)
  fail("Missing scanner writer baseline")
if (topology === "app-only" && process.env.AZURE_SCANNER_CONTAINER_APP_NAME)
  fail("App-only topology cannot omit a configured scanner writer")

const vault = process.env.AZURE_KEY_VAULT_NAME
const registryUser = process.env.GHCR_USERNAME
if (!vault || !registryUser) fail("Missing registry provenance credentials")
const registryToken = run("az", [
  "keyvault",
  "secret",
  "show",
  "--vault-name",
  vault,
  "--name",
  "ghcr-token",
  "--query",
  "value",
  "--output",
  "tsv",
])
if (!registryToken) fail("Registry provenance credential unavailable")
execFileSync("docker", ["login", "ghcr.io", "--username", registryUser, "--password-stdin"], {
  input: registryToken,
  encoding: "utf8",
  timeout: 30_000,
  stdio: ["pipe", "pipe", "pipe"],
})

const writerProtocols = []
const writerIdentities = []
const writerDigests = []
for (const name of [
  process.env.AZURE_APP_CONTAINER_APP_NAME,
  process.env.AZURE_SCANNER_CONTAINER_APP_NAME,
].filter(Boolean)) {
  const revisions = json("az", [
    "containerapp",
    "revision",
    "list",
    "--name",
    name,
    "--resource-group",
    group,
    "--output",
    "json",
  ])
  const active = revisions.filter((revision) => revision.properties?.active === true)
  if (!active.length) fail(`${name} has no active webhook writer baseline`)
  for (const revision of active) {
    const containers = revision.properties?.template?.containers
    if (!Array.isArray(containers) || containers.length !== 1)
      fail("Unexpected writer container topology")
    const container = containers[0]
    const identity =
      container.env?.find((entry) => entry.name === "LYRASHIELD_PRODUCT_REVISION")?.value ??
      container.image?.match(/:([a-f0-9]{40})@sha256:/)?.[1]
    if (
      !sha.test(identity ?? "") ||
      !digest.test(container.image ?? "") ||
      !container.image.includes(`:${identity}@`)
    )
      fail("Writer image and source identity mismatch")
    const imageDigest = container.image.match(/@(sha256:[a-f0-9]{64})$/)?.[1]
    if (!imageDigest) fail("Writer immutable image digest unavailable")
    const imageConfig = json("docker", [
      "buildx",
      "imagetools",
      "inspect",
      container.image,
      "--format",
      "{{json .Image}}",
    ])
    const configs = imageConfig?.config ? [imageConfig] : Object.values(imageConfig ?? {})
    if (
      !configs.length ||
      configs.some(
        (config) => config?.config?.Labels?.["org.opencontainers.image.revision"] !== identity
      )
    )
      fail("Writer OCI revision does not match source identity")
    run("git", ["fetch", "--no-tags", "origin", identity])
    const source = run("git", ["show", `${identity}:packages/billing/src/webhook-tracks.ts`])
    const sourceProtocol = source.match(
      /export const WEBHOOK_TRACK_CLAIM_PROTOCOL\s*=\s*["']([^"']+)["']/
    )?.[1]
    if (![firstProtocol, protocol].includes(sourceProtocol ?? ""))
      fail(`${name} writer source has an unknown claim protocol`)
    writerProtocols.push(sourceProtocol)
    writerIdentities.push(identity)
    writerDigests.push(imageDigest)
  }
}

// Read the running worker only. No one-shot job, restart, queue write or secret read.
const code = `
let prisma;
let probePhase = "MODULES";
try {
  const billing = await import("@lyrashield/billing");
  const { gzipSync } = await import("node:zlib");
  const [rollbackImage, runningImage, imageProduct, imageEngine] = process.argv.slice(1);
  const { getSystemPrisma } = await import("@lyrashield/db");
  prisma = getSystemPrisma();
  probePhase = "SCHEMA";
  const [{ schema }] = await prisma.$queryRawUnsafe("SELECT current_schema() AS schema");
  if (typeof schema !== "string" || !schema) throw new Error("Selected PostgreSQL schema unavailable");
  const quoteIdentifier = (value) => '"' + value.replaceAll('"', '""') + '"';
  const selectedSchema = quoteIdentifier(schema);
  const migrations = ${JSON.stringify(migrationNames)};
  const migrationPlaceholders = migrations.map((_, index) => "$" + (index + 1)).join(", ");
  probePhase = "MIGRATIONS";
  const migrationRows = await prisma.$queryRawUnsafe(
    "SELECT migration_name, checksum, finished_at, rolled_back_at FROM " + selectedSchema + '."_prisma_migrations" WHERE migration_name IN (' + migrationPlaceholders + ")",
    ...migrations,
  );
  probePhase = "COLUMNS";
  const columns = await prisma.$queryRawUnsafe(
    "SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS \\\"notNull\\\", pg_get_expr(d.adbin, d.adrelid) AS \\\"defaultExpr\\\" FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum",
    schema,
    "WebhookEventTrack",
  );
  probePhase = "CONSTRAINTS";
  const constraints = await prisma.$queryRawUnsafe(
    "SELECT conname AS name, contype::text AS type, pg_get_constraintdef(oid, true) AS definition, convalidated AS validated FROM pg_constraint WHERE conrelid = (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r') AND contype IN ('p', 'f', 'c') ORDER BY conname",
    schema,
    "WebhookEventTrack",
  );
  probePhase = "INDEXES";
  const indexes = await prisma.$queryRawUnsafe(
    "SELECT ic.relname AS name, ix.indisunique AS unique, ix.indisvalid AS valid, ix.indisready AS ready, (ix.indpred IS NULL) AS \\\"predicateIsNull\\\", (ix.indnatts = ix.indnkeyatts) AS \\\"noIncludeColumns\\\", (ix.indexprs IS NULL) AS \\\"noExpressions\\\", am.amname AS method, ARRAY(SELECT replace(pg_get_indexdef(ix.indexrelid, position, true), chr(34), '') FROM generate_series(1, ix.indnkeyatts) AS key_column(position) ORDER BY position) AS columns, ARRAY(SELECT NOT pg_index_column_has_property(ix.indexrelid, position, 'desc') AND NOT pg_index_column_has_property(ix.indexrelid, position, 'nulls_first') FROM generate_series(1, ix.indnkeyatts) AS key_column(position) ORDER BY position) AS \\\"defaultOrdering\\\", ARRAY(SELECT opc.opcdefault FROM unnest(ix.indclass) WITH ORDINALITY AS indexed_class(class_oid, class_position) JOIN pg_opclass opc ON opc.oid = indexed_class.class_oid WHERE indexed_class.class_position <= ix.indnkeyatts ORDER BY indexed_class.class_position) AS \\\"defaultOperatorClasses\\\", ARRAY(SELECT indexed_collation.collation_oid = attr.attcollation FROM unnest(ix.indkey) WITH ORDINALITY AS indexed_key(attribute_number, key_position) JOIN pg_attribute attr ON attr.attrelid = ix.indrelid AND attr.attnum = indexed_key.attribute_number JOIN unnest(ix.indcollation) WITH ORDINALITY AS indexed_collation(collation_oid, collation_position) ON indexed_collation.collation_position = indexed_key.key_position WHERE indexed_key.key_position <= ix.indnkeyatts ORDER BY indexed_key.key_position) AS \\\"columnCollationsMatch\\\" FROM pg_index ix JOIN pg_class tc ON tc.oid = ix.indrelid JOIN pg_namespace n ON n.oid = tc.relnamespace JOIN pg_class ic ON ic.oid = ix.indexrelid JOIN pg_am am ON am.oid = ic.relam WHERE n.nspname = $1 AND tc.relname = $2 ORDER BY ic.relname",
    schema,
    "WebhookEventTrack",
  );
  probePhase = "ENCODE";
  const serialized = JSON.stringify({
    version: 1,
    readback: {WORKER_ROLLBACK_IMAGE: rollbackImage, WORKER_IMAGE: runningImage, WORKER_PRODUCT: imageProduct, WORKER_ENGINE: imageEngine},
    protocol: billing.WEBHOOK_TRACK_CLAIM_PROTOCOL,
    product: process.env.LYRASHIELD_PRODUCT_REVISION,
    digest: process.env.LYRASHIELD_WORKER_IMAGE_DIGEST,
    engine: process.env.LYRASHIELD_ENGINE_REVISION,
    schema,
    migrationRows,
    columns,
    constraints,
    indexes,
  });
  if (Buffer.byteLength(serialized) > 65536) throw new Error("Worker catalog exceeds bounded readback");
  const line = "WEBHOOK_WORKER_STATE_GZIP_V1=" + gzipSync(serialized).toString("base64");
  if (Buffer.byteLength(line) > 3500) throw new Error("Worker catalog exceeds Azure readback budget");
  console.log(line);
} catch {
  console.error("WEBHOOK_WORKER_PROBE_ERROR=" + probePhase);
  process.exitCode = 1;
} finally {
  if (prisma) {
    try { await prisma.$disconnect(); } catch {
      console.error("WEBHOOK_WORKER_PROBE_ERROR=DISCONNECT");
      process.exitCode = 1;
    }
  }
}
`
const script = `set -eu
systemctl is-active --quiet lyrashield-worker.service
test "$(docker inspect --format '{{.State.Running}}' lyrashield-worker)" = true
worker_rollback_image="$(sed -n 's/^LYRASHIELD_WORKER_IMAGE=//p' /etc/lyrashield/worker-runtime.conf)"
worker_image="$(docker inspect --format '{{.Config.Image}}' lyrashield-worker)"
worker_product="$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' lyrashield-worker)"
worker_engine="$(docker inspect --format '{{index .Config.Labels "io.lyrashield.engine.revision"}}' lyrashield-worker)"
docker exec -w /app/apps/worker lyrashield-worker node --import tsx --input-type=module -e '${code.replaceAll("'", "'\\''")}' -- "$worker_rollback_image" "$worker_image" "$worker_product" "$worker_engine"`

const response = run("az", [
  "vm",
  "run-command",
  "invoke",
  "--resource-group",
  group,
  "--name",
  worker,
  "--command-id",
  "RunShellScript",
  "--scripts",
  script,
  "--query",
  "value[0].message",
  "--output",
  "tsv",
])
// Action Run Command retains only the last 4096 output bytes. Keep all
// catalog and independent image proof in one final bounded frame.
const errorMarker = "WEBHOOK_WORKER_PROBE_ERROR="
const probeErrors = response.split("\n").filter((line) => line.startsWith(errorMarker))
if (probeErrors.length) {
  const allowedPhases = new Set([
    "MODULES",
    "SCHEMA",
    "MIGRATIONS",
    "COLUMNS",
    "CONSTRAINTS",
    "INDEXES",
    "ENCODE",
    "DISCONNECT",
  ])
  const phases = [
    ...new Set(
      probeErrors.map((line) => {
        const phase = line.slice(errorMarker.length)
        return allowedPhases.has(phase) ? phase : "UNKNOWN"
      })
    ),
  ]
  fail(`Worker compatibility probe failed (${phases.join(", ")})`)
}
const marker = "WEBHOOK_WORKER_STATE_GZIP_V1="
const lines = response.split("\n").filter((line) => line.startsWith(marker))
if (lines.length !== 1) fail("Worker compatibility readback unavailable")
let state
try {
  if (Buffer.byteLength(lines[0]) > 3500) throw new Error("Oversized frame")
  const encoded = lines[0].slice(marker.length)
  const compressed = Buffer.from(encoded, "base64")
  if (!encoded || compressed.toString("base64") !== encoded) throw new Error("Invalid encoding")
  state = JSON.parse(gunzipSync(compressed, { maxOutputLength: 65536 }).toString("utf8"))
  if (!state || typeof state !== "object" || Array.isArray(state) || state.version !== 1)
    throw new Error("Invalid state version")
} catch {
  fail("Worker compatibility readback invalid or oversized")
}
const readback = (key) => state.readback?.[key]

if (
  readback("WORKER_ROLLBACK_IMAGE") !== readback("WORKER_IMAGE") ||
  !readback("WORKER_IMAGE")?.endsWith(`@${state.digest}`) ||
  readback("WORKER_PRODUCT") !== state.product ||
  readback("WORKER_ENGINE") !== state.engine
)
  fail("Worker runtime and image provenance mismatch")
if (
  !sha.test(state.product ?? "") ||
  !sha.test(state.engine ?? "") ||
  !/^sha256:[a-f0-9]{64}$/.test(state.digest ?? "")
)
  fail("Worker immutable provenance unavailable")

const migrationRows = state.migrationRows
if (!Array.isArray(migrationRows)) fail("Webhook migration readback unavailable")
// PostgreSQL may vary keyword casing and whitespace in catalog-rendered SQL,
// but case and whitespace inside literals and quoted identifiers are semantic.
// Only `id` and `generation` are lower-case identifiers in this fixed schema
// whose quoted and unquoted forms are equivalent in the expected definitions.
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
const migrationsMatch = (expected) =>
  migrationRows.length === expected.length &&
  expected.every((name) => {
    const rows = migrationRows.filter((row) => row.migration_name === name)
    return (
      rows.length === 1 &&
      rows[0].checksum === migrationChecksums[name] &&
      rows[0].finished_at != null &&
      rows[0].rolled_back_at === null
    )
  })
const observedColumns = Array.isArray(state.columns) ? state.columns : []
const columns = new Map(observedColumns.map((column) => [column.name, column]))
const columnsMatch = (expected) => {
  if (observedColumns.length !== expected.length || columns.size !== expected.length) return false
  return expected.every(([name, type, notNull, defaultExpr]) => {
    const column = columns.get(name)
    return (
      column?.type === type &&
      column.notNull === notNull &&
      normalizeCatalog(column.defaultExpr) === normalizeCatalog(defaultExpr)
    )
  })
}
const constraintsMatch = () => {
  const observed = Array.isArray(state.constraints) ? state.constraints : []
  if (observed.length !== legacyConstraints.length) return false
  return legacyConstraints.every((expected) => {
    const rows = observed.filter((constraint) => constraint.name === expected.name)
    return (
      rows.length === 1 &&
      rows[0].type === expected.type &&
      rows[0].validated === true &&
      normalizeCatalog(rows[0].definition) === normalizeCatalog(expected.definition)
    )
  })
}
const indexesMatch = () => {
  const expectedIndexes = state.protocol === protocol ? fullyMigratedIndexes : legacyIndexes
  const observed = Array.isArray(state.indexes) ? state.indexes : []
  if (observed.length !== expectedIndexes.length) return false
  return expectedIndexes.every((expected) => {
    const rows = observed.filter((index) => index.name === expected.name)
    if (rows.length !== 1) return false
    const index = rows[0]
    const allTrueForEachKey = (values) =>
      Array.isArray(values) &&
      values.length === expected.columns.length &&
      values.every((value) => value === true)
    return (
      index.unique === expected.unique &&
      index.valid === true &&
      index.ready === true &&
      index.predicateIsNull === true &&
      index.noIncludeColumns === true &&
      index.noExpressions === true &&
      index.method === expected.method &&
      JSON.stringify(index.columns) === JSON.stringify(expected.columns) &&
      allTrueForEachKey(index.defaultOrdering) &&
      allTrueForEachKey(index.defaultOperatorClasses) &&
      allTrueForEachKey(index.columnCollationsMatch)
    )
  })
}
const transitionNames = transitionColumns.map(([name]) => name)
const hasNoTransitionColumns = transitionNames.every((name) => !columns.has(name))
const fullyMigrated =
  state.protocol === protocol &&
  migrationsMatch(migrationNames) &&
  columnsMatch([...fullyMigratedColumns, ...transitionColumns]) &&
  constraintsMatch() &&
  indexesMatch()
const pristineLegacy =
  state.protocol === firstProtocol &&
  state.schema === "public" &&
  state.product === firstWriterRevision &&
  state.engine === firstEngineRevision &&
  state.digest === firstWorkerDigest &&
  migrationsMatch(firstMigrationNames) &&
  columnsMatch(firstMigrationColumns) &&
  hasNoTransitionColumns &&
  constraintsMatch() &&
  indexesMatch() &&
  writerIdentities.every((identity) => identity === firstWriterRevision) &&
  writerDigests.every((imageDigest) => imageDigest === firstWriterDigest)
if (writerProtocols.length === 0) fail("No verified webhook writers were found")
const allWritersMatchWorker = writerProtocols.every(
  (writerProtocol) => writerProtocol === state.protocol
)
const allWritersShareProtocol = writerProtocols.every(
  (writerProtocol) => writerProtocol === writerProtocols[0]
)
let mode
if (
  allWritersMatchWorker &&
  allWritersShareProtocol &&
  writerProtocols[0] === protocol &&
  fullyMigrated
) {
  mode = "compatible"
  console.log(
    "Webhook baseline verified: active writer revisions and live worker are claim-compatible; additive migration completed."
  )
} else if (
  allWritersMatchWorker &&
  allWritersShareProtocol &&
  writerProtocols[0] === firstProtocol &&
  pristineLegacy
) {
  if (!process.env.AZURE_SCANNER_CONTAINER_APP_NAME)
    fail("First-transition classification requires the scanner writer name")
  mode = "first-cutover"
  console.log(
    "First-transition baseline verified: all active writers and the live worker use the recognized durable-claims/1 protocol, and the database matches its exact pre-cutover migration/schema state."
  )
} else {
  fail("Webhook writer, worker and database states do not match a known compatible baseline")
}

if (expectedMode && mode !== expectedMode)
  fail(`Webhook baseline changed after image build (expected ${expectedMode}, found ${mode})`)
if (outputPath) appendFileSync(outputPath, `webhook_claims_cutover=${mode === "first-cutover"}\n`)
