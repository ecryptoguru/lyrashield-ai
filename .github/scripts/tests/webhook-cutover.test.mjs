import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

const script = path.resolve(".github/scripts/verify-webhook-cutover.mjs")
const product = "a".repeat(40)
const engine = "b".repeat(40)
const defaultDigest = `sha256:${"c".repeat(64)}`
const recoverySource = "de92b93a2bef1c44e5837b15949c453f0d8a28c6"
const recoveryWebDigest = "sha256:e0e53a32c37b3bb84ce5832663411f59bbe542faa406c3517983c1a0b4385b9b"
const recoveryWebRepository = "ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-web"
const protocol = "durable-claims/2"
const legacyProduct = "4822306e24f375800981bf282fd992a9c15dcde8"
const legacyEngine = "9d90be5aaf92f86bb5c1ba55a8138545764fdd44"
const legacyWriterDigest = "sha256:dbc43686e11f95a03d9f163c865683e3949ade4179839ef6d268e6ea55f9b78f"
const legacyWorkerDigest = "sha256:d38f8b080ae62b88ba9c6273be76abff42adf5a86b831bde5b19f6d6fce466dc"
const alternateLegacyProduct = "3819345c9ccdc5e96ca7bfd389eaab8d7ea4c530"
const alternateLegacyWriterDigest =
  "sha256:42186658cc92ff0b9037420cfbddb6e54d32c8b9b4e141c2f0d98ed3e1ca9b98"
const alternateLegacyWorkerDigest =
  "sha256:35850652712814b2549ccb3f0a878c1214f6bfca075b350e3db6fcae58382791"
const baselineMigration = "20260822140000_webhook_event_tracks"
const migrationChecksums = {
  [baselineMigration]: "5c7e395649b47940d928e9cc498794a00c6ce73416a4aa0513eff64085c7208d",
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
const migrations = [
  "20260930120000_webhook_track_claims",
  "20261002120000_webhook_track_due_db_default",
  "20261002130000_webhook_track_utc_schedule",
  "20261002130100_webhook_track_utc_schedule_index",
  "20261002130200_webhook_track_operator_recovery",
]

const legacyColumns = [
  { name: "id", type: "text", notNull: true, default: null },
  { name: "webhookEventId", type: "text", notNull: true, default: null },
  { name: "workspaceId", type: "text", notNull: false, default: null },
  { name: "track", type: "text", notNull: true, default: null },
  { name: "status", type: "text", notNull: true, default: "'pending'::text" },
  { name: "attempts", type: "integer", notNull: true, default: "0" },
  { name: "lastError", type: "text", notNull: false, default: null },
  { name: "completedAt", type: "timestamp(3) without time zone", notNull: false, default: null },
  {
    name: "createdAt",
    type: "timestamp(3) without time zone",
    notNull: true,
    default: "CURRENT_TIMESTAMP",
  },
  { name: "updatedAt", type: "timestamp(3) without time zone", notNull: true, default: null },
  { name: "generation", type: "integer", notNull: true, default: "0" },
  { name: "nextAttemptAt", type: "timestamp(3) without time zone", notNull: false, default: null },
  { name: "claimToken", type: "text", notNull: false, default: null },
  { name: "leaseExpiresAt", type: "timestamp(3) without time zone", notNull: false, default: null },
]
const transitionedColumns = [
  { name: "nextAttemptAtUtc", type: "timestamp(3) with time zone", notNull: false, default: null },
  { name: "leaseExpiresAtUtc", type: "timestamp(3) with time zone", notNull: false, default: null },
  { name: "historicalAttempts", type: "integer", notNull: true, default: "0" },
  { name: "operatorRecoveryCount", type: "integer", notNull: true, default: "0" },
]
const indexFixture = (name, columns, unique = false) => ({
  name,
  columns,
  unique,
  valid: true,
  ready: true,
  predicateIsNull: true,
  noIncludeColumns: true,
  noExpressions: true,
  method: "btree",
  defaultOrdering: columns.map(() => true),
  defaultOperatorClasses: columns.map(() => true),
  columnCollationsMatch: columns.map(() => true),
})
const legacyIndexes = [
  indexFixture("WebhookEventTrack_pkey", ["id"], true),
  indexFixture("WebhookEventTrack_webhookEventId_track_key", ["webhookEventId", "track"], true),
  indexFixture("WebhookEventTrack_status_idx", ["status"]),
  indexFixture("WebhookEventTrack_track_status_idx", ["track", "status"]),
  indexFixture("WebhookEventTrack_status_nextAttemptAt_idx", ["status", "nextAttemptAt"]),
]

function fixture(t, scenario, expectedMode) {
  const directory = mkdtempSync(path.join(tmpdir(), "ls-webhook-cutover-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const legacy = scenario === "known legacy" || scenario.startsWith("legacy ")
  const alternate =
    scenario.startsWith("legacy alternate") || scenario === "legacy mixed verified revisions"
  const legacyUnapprovedProduct = "96ffe6a3b3d4b87e3686dc9f2deed1ff25296dc6"
  const recoveryProduced = scenario === "digest-only recovery-produced writer"
  const workerProduct = legacy
    ? scenario === "legacy unapproved source"
      ? legacyUnapprovedProduct
      : alternate
        ? alternateLegacyProduct
        : legacyProduct
    : recoveryProduced
      ? recoverySource
      : product
  const digest = !legacy
    ? defaultDigest
    : scenario === "legacy alternate worker paired with original digest"
      ? legacyWorkerDigest
      : scenario === "legacy alternate worker uses writer digest"
        ? alternateLegacyWriterDigest
        : alternate || scenario === "legacy original source paired with alternate digest"
          ? alternateLegacyWorkerDigest
          : legacyWorkerDigest
  const writerDigest = alternate
    ? alternateLegacyWriterDigest
    : legacy
      ? legacyWriterDigest
      : recoveryProduced
        ? recoveryWebDigest
        : defaultDigest
  const workerImage = `ghcr.io/example/worker:${workerProduct}@${digest}`
  const state = structuredClone({
    protocol: legacy ? "durable-claims/1" : protocol,
    product: workerProduct,
    engine: legacy ? legacyEngine : engine,
    digest,
    migrationNames: legacy
      ? [baselineMigration, migrations[0]]
      : [baselineMigration, ...migrations],
    columns: legacy
      ? legacyColumns
      : [
          ...legacyColumns.map((column) =>
            column.name === "nextAttemptAt" ? { ...column, default: "CURRENT_TIMESTAMP" } : column
          ),
          ...transitionedColumns.map((column) =>
            column.name === "nextAttemptAtUtc"
              ? { ...column, default: "CURRENT_TIMESTAMP" }
              : column
          ),
        ],
    schema: "public",
    constraints: [
      {
        name: "WebhookEventTrack_pkey",
        type: "p",
        definition: "PRIMARY KEY (id)",
        validated: true,
      },
      {
        name: "WebhookEventTrack_webhookEventId_fkey",
        type: "f",
        definition:
          'FOREIGN KEY ("webhookEventId") REFERENCES "WebhookEvent"(id) ON UPDATE CASCADE ON DELETE CASCADE',
        validated: true,
      },
      {
        name: "WebhookEventTrack_generation_nonnegative",
        type: "c",
        definition: "CHECK (generation >= 0)",
        validated: true,
      },
    ],
    indexes: legacy
      ? legacyIndexes
      : [
          ...legacyIndexes,
          indexFixture("WebhookEventTrack_status_nextAttemptAtUtc_idx", [
            "status",
            "nextAttemptAtUtc",
          ]),
        ],
  })
  if (
    scenario === "legacy wrong status literal case" ||
    scenario === "current wrong status literal case"
  ) {
    state.columns = state.columns.map((column) =>
      column.name === "status" ? { ...column, default: "'Pending'::text" } : column
    )
  }
  if (
    scenario === "legacy wrong status literal whitespace" ||
    scenario === "current wrong status literal whitespace"
  ) {
    state.columns = state.columns.map((column) =>
      column.name === "status" ? { ...column, default: "'pending '::text" } : column
    )
  }
  if (scenario === "legacy wrong FK quoted case" || scenario === "current wrong FK quoted case") {
    state.constraints = state.constraints.map((constraint) =>
      constraint.name === "WebhookEventTrack_webhookEventId_fkey"
        ? {
            ...constraint,
            definition:
              'FOREIGN KEY ("webhookeventid") REFERENCES "WebhookEvent"(id) ON UPDATE CASCADE ON DELETE CASCADE',
          }
        : constraint
    )
  }
  if (scenario === "legacy wrong FK target" || scenario === "current wrong FK target") {
    state.constraints = state.constraints.map((constraint) =>
      constraint.name === "WebhookEventTrack_webhookEventId_fkey"
        ? {
            ...constraint,
            definition:
              'FOREIGN KEY ("webhookEventId") REFERENCES "OtherWebhookEvent"(id) ON UPDATE CASCADE ON DELETE CASCADE',
          }
        : constraint
    )
  }
  if (scenario === "old worker") state.protocol = "durable-claims/1"
  if (scenario === "unknown worker protocol") state.protocol = "durable-claims/3"
  if (scenario === "pending migration")
    state.migrationNames = [baselineMigration, ...migrations.slice(0, -1)]
  if (scenario === "legacy partial migration")
    state.migrationNames = [baselineMigration, migrations[0], migrations[1]]
  if (scenario === "legacy partial schema")
    state.columns = [...legacyColumns, transitionedColumns[0]]
  if (scenario === "missing UTC columns")
    state.columns = [...legacyColumns, ...transitionedColumns.slice(0, 3)]
  if (scenario === "legacy wrong generation default")
    state.columns = legacyColumns.map((column) =>
      column.name === "generation" ? { ...column, default: null } : column
    )
  if (scenario === "legacy missing generation check") state.constraints = []
  if (scenario === "legacy invalid schedule index")
    state.indexes = state.indexes.map((index) =>
      index.name === "WebhookEventTrack_status_nextAttemptAt_idx"
        ? { ...index, valid: false }
        : index
    )
  if (scenario === "legacy partial schedule index")
    state.indexes = state.indexes.map((index) =>
      index.name === "WebhookEventTrack_status_nextAttemptAt_idx"
        ? { ...index, predicateIsNull: false }
        : index
    )
  if (scenario === "legacy index with include column")
    state.indexes = state.indexes.map((index) =>
      index.name === "WebhookEventTrack_status_nextAttemptAt_idx"
        ? { ...index, noIncludeColumns: false }
        : index
    )
  if (scenario === "legacy expression index")
    state.indexes = state.indexes.map((index) =>
      index.name === "WebhookEventTrack_status_nextAttemptAt_idx"
        ? { ...index, noExpressions: false }
        : index
    )
  if (scenario === "legacy wrong index ordering")
    state.indexes = state.indexes.map((index) =>
      index.name === "WebhookEventTrack_status_nextAttemptAt_idx"
        ? { ...index, defaultOrdering: [false, true] }
        : index
    )
  if (scenario === "legacy nondefault operator class")
    state.indexes = state.indexes.map((index) =>
      index.name === "WebhookEventTrack_status_nextAttemptAt_idx"
        ? { ...index, defaultOperatorClasses: [false, true] }
        : index
    )
  if (scenario === "legacy collation mismatch")
    state.indexes = state.indexes.map((index) =>
      index.name === "WebhookEventTrack_status_nextAttemptAt_idx"
        ? { ...index, columnCollationsMatch: [false, true] }
        : index
    )
  if (scenario === "legacy missing operator class evidence")
    state.indexes = state.indexes.map((index) =>
      index.name === "WebhookEventTrack_status_nextAttemptAt_idx"
        ? { ...index, defaultOperatorClasses: [] }
        : index
    )
  if (scenario === "legacy missing collation evidence")
    state.indexes = state.indexes.map((index) =>
      index.name === "WebhookEventTrack_status_nextAttemptAt_idx"
        ? { ...index, columnCollationsMatch: [] }
        : index
    )
  if (scenario === "legacy index not ready")
    state.indexes = state.indexes.map((index) =>
      index.name === "WebhookEventTrack_status_nextAttemptAt_idx"
        ? { ...index, ready: false }
        : index
    )
  if (scenario === "legacy extra index")
    state.indexes.push({
      name: "WebhookEventTrack_unknown_idx",
      columns: ["track"],
      unique: false,
      valid: true,
      ready: true,
      predicateIsNull: true,
      noIncludeColumns: true,
      noExpressions: true,
      method: "btree",
      defaultOrdering: [true],
      defaultOperatorClasses: [true],
      columnCollationsMatch: [true],
    })
  if (scenario === "legacy extra column")
    state.columns.push({ name: "unexpected", type: "text", notNull: false, default: null })
  if (scenario === "legacy cross-schema only") {
    state.foreignSchemaColumns = state.columns
    state.columns = []
  }
  if (scenario === "legacy nonpublic schema") state.schema = "application"
  if (scenario === "wrong migration checksum") state.badMigrationChecksum = true
  if (scenario === "unfinished migration") state.unfinishedMigration = migrations.at(-1)
  if (scenario === "rolled-back migration") state.rolledBackMigration = migrations.at(-1)
  if (scenario === "legacy wrong engine") state.engine = engine
  if (scenario === "legacy wrong worker digest") state.digest = defaultDigest
  if (scenario === "v2 missing UTC index")
    state.indexes = state.indexes.filter(
      (index) => index.name !== "WebhookEventTrack_status_nextAttemptAtUtc_idx"
    )
  if (scenario === "v2 invalid UTC index")
    state.indexes = state.indexes.map((index) =>
      index.name === "WebhookEventTrack_status_nextAttemptAtUtc_idx"
        ? { ...index, valid: false }
        : index
    )
  if (scenario === "missing provenance") state.engine = undefined

  const revision = (
    revisionProduct,
    active = true,
    badImage = false,
    imageDigest = writerDigest
  ) => {
    const digestOnly = scenario.startsWith("digest-only")
    const tag =
      scenario === "conflicting writer tag"
        ? "d".repeat(40)
        : scenario === "mutable writer tag with digest"
          ? "latest"
          : revisionProduct
    const image = badImage
      ? "image:latest"
      : digestOnly
        ? `${recoveryProduced ? recoveryWebRepository : "ghcr.io/example/worker"}@${scenario === "digest-only malformed digest" ? "sha256:bad" : imageDigest}`
        : `ghcr.io/example/worker:${tag}@${imageDigest}`
    const env =
      scenario === "digest-only missing identity" ||
      scenario === "tagged writer image without explicit env"
        ? []
        : [
            {
              name: "LYRASHIELD_PRODUCT_REVISION",
              value:
                scenario === "digest-only malformed identity"
                  ? "invalid"
                  : scenario === "tagged writer env mismatch"
                    ? "d".repeat(40)
                    : revisionProduct,
            },
          ]
    if (scenario === "digest-only duplicate identity")
      env.push({ name: "LYRASHIELD_PRODUCT_REVISION", value: "d".repeat(40) })
    return { properties: { active, template: { containers: [{ image, env }] } } }
  }
  const appRevisions = legacy
    ? [
        revision(
          workerProduct,
          true,
          false,
          scenario === "legacy wrong writer digest"
            ? defaultDigest
            : scenario === "legacy alternate writer paired with original digest"
              ? legacyWriterDigest
              : scenario === "legacy alternate writer uses worker digest"
                ? alternateLegacyWorkerDigest
                : writerDigest
        ),
      ]
    : [revision(workerProduct)]
  const scannerRevisions = [...appRevisions]
  if (scenario === "digest-only scanner missing identity") {
    scannerRevisions[0] = structuredClone(appRevisions[0])
    scannerRevisions[0].properties.template.containers[0].env = []
  }
  if (scenario === "legacy mixed verified revisions") {
    appRevisions.push(revision(legacyProduct, true, false, legacyWriterDigest))
    scannerRevisions.push(revision(legacyProduct, true, false, legacyWriterDigest))
  }
  if (scenario === "no active app")
    appRevisions[0] = revision(legacy ? legacyProduct : product, false)
  if (scenario === "image mismatch") appRevisions[0] = revision(product, true, true)
  if (scenario === "mixed writers") scannerRevisions[0] = revision(legacyProduct)
  if (scenario === "mixed app revisions")
    appRevisions.splice(0, appRevisions.length, revision(legacyProduct), revision(product))

  if (scenario === "producer decoded oversized") state.columns[0].default = "x".repeat(70000)
  if (scenario === "producer wire oversized")
    state.columns[0].default = Array.from({ length: 300 }, (_, i) =>
      createHash("sha256").update(String(i)).digest("hex")
    ).join("")
  const executable = (name, body) => {
    const file = path.join(directory, name)
    writeFileSync(file, `#!${process.execPath}\n${body}`)
    chmodSync(file, 0o755)
  }
  executable(
    "systemctl",
    `const scenario=${JSON.stringify(scenario)}; const state=scenario==="worker service inactive"?"inactive":scenario==="worker service failed"?"failed":scenario==="worker service transitional"?"activating":scenario==="worker service unknown"?"unexpected":"active"; process.stdout.write(state+"\\n"); process.exit(state==="active"?0:3)`
  )
  executable(
    "sed",
    `if(${JSON.stringify(scenario)}==="worker rollback image unavailable") process.exit(1); console.log(${JSON.stringify(scenario === "rollback mismatch" ? "legacy" : workerImage)})`
  )
  executable(
    "docker",
    `const args=process.argv.slice(2); if(args[0]==="login") process.exit(0); if(args[0]==="buildx") { const inspected=args[3]; const revision=inspected.match(/:([a-f0-9]{40})@sha256:/)?.[1]??process.env.SYNTHETIC_WRITER_OCI_REVISION; console.log(JSON.stringify({config:{Labels:{"org.opencontainers.image.revision":${JSON.stringify(scenario === "OCI mismatch" ? "legacy" : "")} || revision}}})); } else if(args[0]==="inspect") { const format=args[2]; if((${JSON.stringify(scenario)}==="worker container inspect failed" && format.includes("State.Running")) || (${JSON.stringify(scenario)}==="worker image inspect failed" && format.includes("Config.Image")) || (${JSON.stringify(scenario)}==="worker image provenance inspect failed" && format.includes("engine.revision"))) process.exit(1); console.log(format.includes("State.Running")?${JSON.stringify(scenario === "worker container stopped" ? "false" : "true")}:format.includes("Config.Image")?${JSON.stringify(workerImage)}:format.includes("engine.revision")?${JSON.stringify(scenario === "worker image provenance missing" ? "" : state.engine)}:${JSON.stringify(scenario === "worker image provenance missing" ? "" : workerProduct)}); } else if(args[0]==="exec") { if(${JSON.stringify(scenario)}==="worker exec unavailable") process.exit(1); const code=args[args.indexOf("-e")+1]; process.argv=[process.execPath,...args.slice(args.indexOf("-e")+3)]; const state=${JSON.stringify(state)}; const expectedChecksums=${JSON.stringify(migrationChecksums)}; process.env.LYRASHIELD_PRODUCT_REVISION=state.product; process.env.LYRASHIELD_WORKER_IMAGE_DIGEST=state.digest; if(state.engine) process.env.LYRASHIELD_ENGINE_REVISION=state.engine; else delete process.env.LYRASHIELD_ENGINE_REVISION; const prisma={$queryRawUnsafe:async(query,...parameters)=>{ if(${JSON.stringify(scenario)}==="probe error redaction") throw new Error("SYNTHETIC_CREDENTIAL_DO_NOT_LOG"); if(query.includes("current_schema()")) return [{schema:state.schema}]; if(query.includes("_prisma_migrations")) return state.migrationNames.map(migration_name=>({migration_name,checksum:state.badMigrationChecksum?"0".repeat(64):expectedChecksums[migration_name],finished_at:migration_name===state.unfinishedMigration?null:new Date(),rolled_back_at:migration_name===state.rolledBackMigration?new Date():null})); if(query.includes("FROM pg_attribute a")) return (query.includes("pg_namespace")?state.columns:[...(state.columns??[]),...(state.foreignSchemaColumns??[])]).map(column=>({...column,defaultExpr:column.default})); if(query.includes("pg_constraint")) {if(!query.includes("contype::text AS type")) throw new Error("UnsupportedNativeDataType: char");return state.constraints;} if(query.includes("pg_index")) return state.indexes; throw new Error("Unexpected worker schema probe"); },$disconnect:async()=>{if(${JSON.stringify(scenario)}==="disconnect error redaction")throw new Error("SYNTHETIC_CREDENTIAL_DO_NOT_LOG")}}; const load=async(name)=>name==="node:zlib"?import("node:zlib"):name==="@lyrashield/billing"?{WEBHOOK_TRACK_CLAIM_PROTOCOL:state.protocol}:name==="@lyrashield/db"?{getSystemPrisma:()=>prisma}:Promise.reject(new Error("Unexpected module")); new Function("load","return (async()=>{"+code.replaceAll("import(","load(")+"})()")(load).catch(error=>{console.error(error.message);process.exit(1)}); } else process.exit(1);`
  )
  executable(
    "az",
    `const {spawnSync}=require("node:child_process"); const args=process.argv.slice(2); if(args[0]==="keyvault") console.log("synthetic-registry-token"); else if(args[0]==="containerapp") { const name=args[args.indexOf("--name")+1]; console.log(JSON.stringify(name==="app"?${JSON.stringify(appRevisions)}:${JSON.stringify(scannerRevisions)})); } else { if(${JSON.stringify(scenario)}==="VM failure") process.exit(1); const result=spawnSync("sh",["-c",args[args.indexOf("--scripts")+1]],{encoding:"utf8"}); const {gzipSync,gunzipSync}=require("node:zlib");const marker="WEBHOOK_WORKER_STATE_GZIP_V1=";let out=result.stdout;const scenario=${JSON.stringify(scenario)};const framed=(value)=>marker+gzipSync(value).toString("base64")+"\\n";if(scenario==="missing frame")out="";if(scenario==="duplicate frame")out=framed("{}")+framed("{}");if(scenario==="malformed base64")out=marker+"!bad!\\n";if(scenario==="invalid gzip")out=marker+Buffer.from("not gzip").toString("base64")+"\\n";if(scenario==="invalid JSON")out=framed("{");if(scenario==="null state")out=framed("null");if(scenario==="decompression bomb")out=framed("x".repeat(65537));if(scenario==="wire oversized")out=marker+"A".repeat(3500)+"\\n";if(scenario==="truncated frame")out=out.slice(0,Math.floor(out.length/2))+"\\n";if(scenario==="corrupt gzip"){const bytes=Buffer.from(out.trim().slice(marker.length),"base64");bytes[bytes.length-8]^=1;out=marker+bytes.toString("base64")+"\\n";}if(scenario==="untrusted error redaction")out+="WEBHOOK_WORKER_PROBE_ERROR=SYNTHETIC_CREDENTIAL_DO_NOT_LOG\\n";if(scenario==="unknown frame version"){const encoded=out.trim().slice(marker.length);const value=JSON.parse(gunzipSync(Buffer.from(encoded,"base64")));value.version=2;out=framed(JSON.stringify(value));}process.stdout.write(Buffer.from("[stdout]\\n"+out+"\\n[stderr]\\n"+result.stderr).subarray(-4096));process.exit(0); }`
  )
  executable(
    "git",
    `if(process.argv[2]==="show") { const identity=process.argv[3].split(":")[0]; console.log([${JSON.stringify(legacyProduct)},${JSON.stringify(alternateLegacyProduct)},${JSON.stringify(legacyUnapprovedProduct)}].includes(identity)?${JSON.stringify('export const WEBHOOK_TRACK_CLAIM_PROTOCOL = "durable-claims/1"')}:${JSON.stringify(scenario === "unknown writer source" ? "export const OTHER_PROTOCOL = true" : `export const WEBHOOK_TRACK_CLAIM_PROTOCOL = "${protocol}"`)}); }`
  )
  const output = path.join(directory, "github-output")
  writeFileSync(output, "")
  const args = [script, "--github-output", output]
  if (expectedMode) args.push("--expect-mode", expectedMode)
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      AZURE_KEY_VAULT_NAME: "vault",
      GHCR_USERNAME: "owner",
      AZURE_WEBHOOK_WRITER_TOPOLOGY:
        scenario === "unknown topology"
          ? "unknown"
          : ["explicit app-only", "app-only with scanner"].includes(scenario)
            ? "app-only"
            : "app-and-scanner",
      AZURE_RESOURCE_GROUP: "test",
      SYNTHETIC_WRITER_OCI_REVISION: scenario.startsWith("digest-only")
        ? scenario === "digest-only wrong OCI label"
          ? "legacy"
          : workerProduct
        : "",
      AZURE_WORKER_VM_NAME: "worker",
      AZURE_APP_CONTAINER_APP_NAME: "app",
      AZURE_SCANNER_CONTAINER_APP_NAME: [
        "legacy missing scanner",
        "ordinary missing scanner",
        "explicit app-only",
      ].includes(scenario)
        ? ""
        : "scanner",
    },
  })
  return { ...result, githubOutput: readFileSync(output, "utf8") }
}

test("fully compatible writers and migrations select ordinary release", (t) => {
  const result = fixture(t, "compatible")
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Webhook baseline verified/)
  assert.match(result.githubOutput, /webhook_claims_cutover=false/)
})

test("digest-only writer image with explicit revision selects ordinary release", (t) => {
  const result = fixture(t, "digest-only writer image")
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.githubOutput, /webhook_claims_cutover=false/)
})

test("recovery-produced digest-only web reference reaches the installed-writer verifier", (t) => {
  const runtime = readFileSync(".github/workflows/deploy-azure-runtime.yml", "utf8")
  const prepare = readFileSync(".github/workflows/prepare-worker-recovery-candidate.yml", "utf8")
  const rollout = readFileSync(".github/scripts/deploy-azure-rollout.sh", "utf8")
  assert.match(runtime, /IMAGE: \$\{\{ inputs\.web_image \}\}@\$\{\{ inputs\.web_digest \}\}/)
  assert.match(prepare, /org\.opencontainers\.image\.revision=\$\{\{ inputs\.source_sha \}\}/)
  assert.match(rollout, /LYRASHIELD_PRODUCT_REVISION=\$\{DEPLOY_SHA\}/)
  const result = fixture(t, "digest-only recovery-produced writer", "compatible")
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.githubOutput, /webhook_claims_cutover=false/)
})

test("tagged immutable writer image can bind identity from its tag and OCI label", (t) => {
  const result = fixture(t, "tagged writer image without explicit env")
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.githubOutput, /webhook_claims_cutover=false/)
})

test("worker Run Command failures are sanitized and do not select a deploy mode", (t) => {
  const result = fixture(t, "VM failure")
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Worker compatibility probe failed \(RUN_COMMAND\)/)
  assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_CREDENTIAL_DO_NOT_LOG/)
  assert.equal(result.githubOutput, "")
})

test("exact legacy writers and pristine legacy schema select automatic maintenance release", (t) => {
  const result = fixture(t, "known legacy")
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /First-transition baseline verified/)
  assert.match(result.githubOutput, /webhook_claims_cutover=true/)
})

for (const scenario of ["legacy alternate verified source", "legacy mixed verified revisions"]) {
  test(`exact evidence-backed legacy artifact profiles select maintenance: ${scenario}`, (t) => {
    const result = fixture(t, scenario)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.githubOutput, /webhook_claims_cutover=true/)
  })
}

test("runtime rejects a legacy classification that differs from the pre-build result", (t) => {
  const result = fixture(t, "known legacy", "compatible")
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /baseline changed after image build/)
  assert.equal(result.githubOutput, "")
})

for (const scenario of [
  "pending migration",
  "missing UTC columns",
  "old worker",
  "no active app",
  "image mismatch",
  "digest-only missing identity",
  "digest-only scanner missing identity",
  "digest-only malformed identity",
  "digest-only duplicate identity",
  "digest-only malformed digest",
  "digest-only wrong OCI label",
  "conflicting writer tag",
  "mutable writer tag with digest",
  "tagged writer env mismatch",
  "missing provenance",
  "rollback mismatch",
  "legacy partial migration",
  "legacy partial schema",
  "legacy wrong generation default",
  "legacy wrong status literal case",
  "current wrong status literal case",
  "legacy wrong status literal whitespace",
  "current wrong status literal whitespace",
  "legacy wrong FK quoted case",
  "current wrong FK quoted case",
  "legacy wrong FK target",
  "current wrong FK target",
  "legacy missing generation check",
  "legacy invalid schedule index",
  "legacy partial schedule index",
  "legacy index with include column",
  "legacy expression index",
  "legacy wrong index ordering",
  "legacy nondefault operator class",
  "legacy collation mismatch",
  "legacy missing operator class evidence",
  "legacy missing collation evidence",
  "legacy index not ready",
  "legacy extra index",
  "legacy extra column",
  "legacy cross-schema only",
  "legacy nonpublic schema",
  "legacy unapproved source",
  "legacy wrong engine",
  "legacy wrong worker digest",
  "legacy wrong writer digest",
  "legacy alternate worker paired with original digest",
  "legacy alternate writer paired with original digest",
  "legacy alternate worker uses writer digest",
  "legacy alternate writer uses worker digest",
  "legacy original source paired with alternate digest",
  "legacy missing scanner",
  "unfinished migration",
  "rolled-back migration",
  "wrong migration checksum",
  "v2 missing UTC index",
  "v2 invalid UTC index",
  "mixed writers",
  "mixed app revisions",
  "unknown writer source",
  "unknown worker protocol",
  "OCI mismatch",
  "VM failure",
]) {
  test(`cutover classification fails closed: ${scenario}`, (t) => {
    const result = fixture(t, scenario)
    assert.notEqual(result.status, 0)
    assert.equal(result.githubOutput, "", "failed preflight must not emit a deploy mode")
  })
}

test("guard precedes configuration and migration mutations in protected production job", () => {
  const workflow = readFileSync(".github/workflows/deploy-azure-runtime.yml", "utf8")
  const gate = workflow.indexOf("- name: Verify compatible webhook cutover baseline")
  assert.ok(gate > workflow.indexOf("name: azure-production"))
  for (const step of [
    "Ensure app and scanner system identities",
    "Prepare private registry and zero-downtime rollout",
    "Run database migrations",
    "Promote healthy candidate revisions",
    "Promote verified worker digest on VM",
  ]) {
    assert.ok(gate < workflow.indexOf(`- name: ${step}`), step)
  }
  assert.doesNotMatch(readFileSync(script, "utf8"), /BYPASS|ALLOW_UNSAFE|CONFIRMATION/)
})

test("runtime re-verifies the classifier result before any production mutation", () => {
  const workflow = readFileSync(".github/workflows/deploy-azure-runtime.yml", "utf8")
  const verifier = workflow.indexOf("- name: Verify compatible webhook cutover baseline")
  assert.match(workflow.slice(verifier), /--expect-mode/)
  for (const mutation of [
    "Ensure app and scanner system identities",
    "Prepare private registry and zero-downtime rollout",
    "Run database migrations",
  ]) {
    assert.ok(verifier < workflow.indexOf(`- name: ${mutation}`), mutation)
  }
})

test("preflight classifier output gates both image build and runtime maintenance mode", () => {
  const workflow = readFileSync(".github/workflows/deploy-azure.yml", "utf8")
  const preflight = readFileSync(".github/scripts/verify-webhook-cutover-preflight.mjs", "utf8")
  assert.match(
    workflow,
    /outputs:[\s\S]*webhook_claims_cutover:[\s\S]*steps\.verify-baseline\.outputs\.webhook_claims_cutover/
  )
  assert.match(workflow, /run: node \.github\/scripts\/verify-webhook-cutover-preflight\.mjs/)
  assert.match(preflight, /verify-webhook-cutover\.mjs", "--github-output", outputPath/)
  assert.match(
    workflow,
    /webhook_claims_cutover:\s*\$\{\{\s*needs\.preflight-compatible-baseline\.outputs\.webhook_claims_cutover == 'true'\s*\}\}/
  )
})

test("ordinary and automatic-cutover guards share worker name and preserve owned recovery", () => {
  const runtime = readFileSync(".github/workflows/deploy-azure-runtime.yml", "utf8")
  assert.match(runtime, /bash \.github\/scripts\/webhook-claims-maintenance\.sh recovery/)
  for (const guardName of [
    "Verify compatible webhook cutover baseline",
    "Verify installed compatible webhook writer baseline",
  ]) {
    const start = runtime.indexOf(`- name: ${guardName}`)
    assert.ok(start >= 0)
    const end = runtime.indexOf("run: node .github/scripts/verify-webhook-cutover.mjs", start)
    assert.ok(end >= 0)
    assert.match(
      runtime.slice(start, end),
      /AZURE_WORKER_VM_NAME:\s*\$\{\{\s*vars\.AZURE_WORKER_VM_NAME\s*\|\|\s*'lyrashield-worker'\s*\}\}/
    )
  }
})

test("web images bind the exact source revision into OCI provenance", () => {
  const workflow = readFileSync(".github/workflows/deploy-azure.yml", "utf8")
  const web = workflow.slice(
    workflow.indexOf("- name: Build and push web image"),
    workflow.indexOf("- name: Build and push worker image")
  )
  assert.match(web, /org\.opencontainers\.image\.revision=\$\{\{ env\.DEPLOY_SHA \}\}/)
})

for (const scenario of [
  "missing frame",
  "duplicate frame",
  "malformed base64",
  "invalid gzip",
  "invalid JSON",
  "null state",
  "decompression bomb",
  "wire oversized",
  "truncated frame",
  "corrupt gzip",
  "unknown frame version",
  "producer decoded oversized",
  "producer wire oversized",
  "probe error redaction",
  "disconnect error redaction",
  "untrusted error redaction",
  "worker service inactive",
  "worker service failed",
  "worker service transitional",
  "worker service unknown",
  "worker rollback image unavailable",
  "worker container inspect failed",
  "worker image inspect failed",
  "worker image provenance inspect failed",
  "worker image provenance missing",
  "worker container stopped",
  "worker exec unavailable",
]) {
  test(`bounded worker transport fails closed without choosing a mode: ${scenario}`, (t) => {
    const result = fixture(t, scenario)
    assert.notEqual(result.status, 0)
    assert.equal(result.githubOutput, "")
    assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_CREDENTIAL_DO_NOT_LOG/)
    const expected = ["missing frame", "duplicate frame"].includes(scenario)
      ? /Worker compatibility readback unavailable/
      : scenario.startsWith("worker ")
        ? /Worker compatibility probe failed/
        : scenario.startsWith("producer ") || scenario.endsWith("error redaction")
          ? /Worker compatibility probe failed/
          : /Worker compatibility readback invalid or oversized/
    assert.match(result.stderr, expected)
    const workerPhases = {
      "worker service inactive": "WORKER_SERVICE_INACTIVE",
      "worker service failed": "WORKER_SERVICE_FAILED",
      "worker service transitional": "WORKER_SERVICE_TRANSITION",
      "worker service unknown": "WORKER_SERVICE_STATE",
      "worker rollback image unavailable": "WORKER_ROLLBACK_IMAGE",
      "worker container inspect failed": "WORKER_CONTAINER_INSPECT",
      "worker image inspect failed": "WORKER_IMAGE_INSPECT",
      "worker image provenance inspect failed": "WORKER_IMAGE_PROVENANCE",
      "worker image provenance missing": "WORKER_IMAGE_PROVENANCE",
      "worker container stopped": "WORKER_CONTAINER_STOPPED",
      "worker exec unavailable": "EXECUTION",
    }
    if (workerPhases[scenario]) {
      assert.match(result.stderr, /Worker compatibility probe failed \(/)
      assert.ok(result.stderr.includes(`${workerPhases[scenario]})`))
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /(?:^|\n)(?:inactive|failed|activating|unexpected)(?:\r?\n|$)/
      )
    }
  })
}

test("baseline mismatch exposes fixed boolean predicates without admitting an unknown source", (t) => {
  const result = fixture(t, "legacy unapproved source")
  assert.notEqual(result.status, 0)
  assert.equal(result.githubOutput, "")
  const line = result.stdout
    .split("\n")
    .find((value) => value.startsWith("WEBHOOK_BASELINE_MATCHES="))
  assert.ok(line)
  const matches = JSON.parse(line.slice("WEBHOOK_BASELINE_MATCHES=".length))
  assert.equal(matches.legacyWorkerSource, false)
  assert.equal(matches.legacyMigrations, true)
  assert.equal(matches.legacyColumns, true)
  assert.equal(matches.constraints, true)
  assert.equal(matches.indexes, true)
  assert.ok(Object.values(matches).every((value) => typeof value === "boolean"))
  assert.doesNotMatch(line, /[a-f0-9]{40}|sha256:|postgres:|pending|SYNTHETIC_CREDENTIAL/)
})

test("ordinary app-only rollout requires explicit topology", (t) => {
  const appOnly = fixture(t, "explicit app-only")
  assert.equal(appOnly.status, 0, appOnly.stderr)
  for (const scenario of [
    "ordinary missing scanner",
    "app-only with scanner",
    "unknown topology",
  ]) {
    const rejected = fixture(t, scenario)
    assert.notEqual(rejected.status, 0)
    assert.equal(rejected.githubOutput, "")
  }
})
