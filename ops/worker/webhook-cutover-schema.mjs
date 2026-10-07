const protocol = "durable-claims/2"

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
const migrationNames = Object.keys(migrationChecksums)
const columns = [
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
  ["nextAttemptAt", "timestamp(3) without time zone", false, "CURRENT_TIMESTAMP"],
  ["claimToken", "text", false, null],
  ["leaseExpiresAt", "timestamp(3) without time zone", false, null],
  ["nextAttemptAtUtc", "timestamp(3) with time zone", false, "CURRENT_TIMESTAMP"],
  ["leaseExpiresAtUtc", "timestamp(3) with time zone", false, null],
  ["historicalAttempts", "integer", true, "0"],
  ["operatorRecoveryCount", "integer", true, "0"],
]
const constraints = [
  ["WebhookEventTrack_pkey", "p", "primary key (id)"],
  [
    "WebhookEventTrack_webhookEventId_fkey",
    "f",
    'foreign key ("webhookEventId") references "WebhookEvent"(id) on update cascade on delete cascade',
  ],
  ["WebhookEventTrack_generation_nonnegative", "c", "check (generation >= 0)"],
]
const indexes = [
  ["WebhookEventTrack_pkey", ["id"], true],
  ["WebhookEventTrack_webhookEventId_track_key", ["webhookEventId", "track"], true],
  ["WebhookEventTrack_status_idx", ["status"], false],
  ["WebhookEventTrack_track_status_idx", ["track", "status"], false],
  ["WebhookEventTrack_status_nextAttemptAt_idx", ["status", "nextAttemptAt"], false],
  ["WebhookEventTrack_status_nextAttemptAtUtc_idx", ["status", "nextAttemptAtUtc"], false],
]

const lowerUnquotedCatalogIdentifiers = new Set(["id", "generation"])
function normalizeCatalog(value) {
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
      if (quote === "'") append(source.slice(start, index))
      else if (lowerUnquotedCatalogIdentifiers.has(contents) && /^[a-z_][a-z0-9_$]*$/.test(contents))
        append(contents)
      else append(`"${contents.replaceAll('"', '""')}"`)
      continue
    }
    const start = index
    while (
      index < source.length &&
      !/\s/.test(source[index]) &&
      source[index] !== "'" &&
      source[index] !== '"'
    ) index += 1
    append(source.slice(start, index).toLowerCase())
  }
  return normalized.trim()
}

function requireMatch(condition, label) {
  if (!condition) throw new Error(`Webhook recovery requires exact migrated schema (${label})`)
}

function expectedRuntimePrincipal(databaseUrl) {
  let url
  try {
    url = new URL(databaseUrl)
  } catch {
    throw new Error("Webhook recovery runtime database identity is invalid")
  }
  let username
  try {
    username = decodeURIComponent(url.username)
  } catch {
    throw new Error("Webhook recovery runtime database identity is invalid")
  }
  let principal = username
  if (/\.pooler\.supabase\.com$/i.test(url.hostname)) {
    const pooler = /^([a-z_][a-z0-9_$]{0,62})\.([a-z0-9]{20})$/i.exec(username)
    requireMatch(pooler !== null, "runtime database principal")
    principal = pooler[1]
  }
  requireMatch(/^[a-z_][a-z0-9_$]{0,62}$/i.test(principal), "runtime database principal")
  requireMatch(principal !== "postgres", "runtime database principal")
  return principal
}

export async function assertRuntimeRoleLeastPrivilege(runtimePrisma, databaseUrl) {
  const expectedPrincipal = expectedRuntimePrincipal(databaseUrl)
  const roles = await runtimePrisma.$queryRawUnsafe(
    "SELECT current_user AS role_name, role.rolsuper, role.rolbypassrls FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user",
  )
  requireMatch(
    Array.isArray(roles) &&
      roles.length === 1 &&
      roles[0].role_name === expectedPrincipal &&
      roles[0].rolsuper === false &&
      roles[0].rolbypassrls === false,
    "runtime principal privileges",
  )
  return true
}

export async function assertFullyMigratedWebhookSchema(prisma, claimProtocol) {
  requireMatch(claimProtocol === protocol, "protocol")
  const [{ schema }] = await prisma.$queryRawUnsafe("SELECT pg_catalog.current_schema() AS schema")
  requireMatch(typeof schema === "string" && schema.length > 0, "schema")
  const quoteIdentifier = (value) => '"' + value.replaceAll('"', '""') + '"'
  const selectedSchema = quoteIdentifier(schema)
  const placeholders = migrationNames.map((_, index) => `$${index + 1}`).join(", ")
  const migrationRows = await prisma.$queryRawUnsafe(
    `SELECT migration_name, checksum, finished_at, rolled_back_at FROM ${selectedSchema}._prisma_migrations WHERE migration_name IN (${placeholders})`,
    ...migrationNames,
  )
  requireMatch(
    Array.isArray(migrationRows) &&
      migrationRows.length === migrationNames.length &&
      migrationNames.every((name) => {
        const rows = migrationRows.filter((row) => row.migration_name === name)
        return (
          rows.length === 1 &&
          rows[0].checksum === migrationChecksums[name] &&
          rows[0].finished_at != null &&
          rows[0].rolled_back_at === null
        )
      }),
    "migration checksums",
  )
  const observedColumns = await prisma.$queryRawUnsafe(
    'SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS "notNull", pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS "defaultExpr" FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = \'r\' AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum',
    schema,
    "WebhookEventTrack",
  )
  const columnMap = new Map((Array.isArray(observedColumns) ? observedColumns : []).map((row) => [row.name, row]))
  requireMatch(columnMap.size === columns.length && columns.every(([name, type, notNull, defaultExpr]) => {
    const row = columnMap.get(name)
    return row?.type === type && row.notNull === notNull && normalizeCatalog(row.defaultExpr) === normalizeCatalog(defaultExpr)
  }), "columns")
  const observedConstraints = await prisma.$queryRawUnsafe(
    "SELECT conname AS name, contype::text AS type, pg_catalog.pg_get_constraintdef(oid, true) AS definition, convalidated AS validated FROM pg_catalog.pg_constraint WHERE conrelid = (SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r') AND contype IN ('p', 'f', 'c') ORDER BY conname",
    schema,
    "WebhookEventTrack",
  )
  requireMatch(
    Array.isArray(observedConstraints) &&
      observedConstraints.length === constraints.length &&
      constraints.every(([name, type, definition]) => {
        const rows = observedConstraints.filter((row) => row.name === name)
        return rows.length === 1 && rows[0].type === type && rows[0].validated === true && normalizeCatalog(rows[0].definition) === normalizeCatalog(definition)
      }),
    "constraints",
  )
  const observedIndexes = await prisma.$queryRawUnsafe(
    'SELECT ic.relname AS name, ix.indisunique AS unique, ix.indisvalid AS valid, ix.indisready AS ready, (ix.indpred IS NULL) AS "predicateIsNull", (ix.indnatts = ix.indnkeyatts) AS "noIncludeColumns", (ix.indexprs IS NULL) AS "noExpressions", am.amname AS method, ARRAY(SELECT pg_catalog.replace(pg_catalog.pg_get_indexdef(ix.indexrelid, position, true), pg_catalog.chr(34), \'\') FROM pg_catalog.generate_series(1, ix.indnkeyatts) AS key_column(position) ORDER BY position) AS columns, ARRAY(SELECT NOT pg_catalog.pg_index_column_has_property(ix.indexrelid, position, \'desc\') AND NOT pg_catalog.pg_index_column_has_property(ix.indexrelid, position, \'nulls_first\') FROM pg_catalog.generate_series(1, ix.indnkeyatts) AS key_column(position) ORDER BY position) AS "defaultOrdering", ARRAY(SELECT opc.opcdefault FROM pg_catalog.unnest(ix.indclass) WITH ORDINALITY AS indexed_class(class_oid, class_position) JOIN pg_catalog.pg_opclass opc ON opc.oid = indexed_class.class_oid WHERE indexed_class.class_position <= ix.indnkeyatts ORDER BY indexed_class.class_position) AS "defaultOperatorClasses", ARRAY(SELECT indexed_collation.collation_oid = attr.attcollation FROM pg_catalog.unnest(ix.indkey) WITH ORDINALITY AS indexed_key(attribute_number, key_position) JOIN pg_catalog.pg_attribute attr ON attr.attrelid = ix.indrelid AND attr.attnum = indexed_key.attribute_number JOIN pg_catalog.unnest(ix.indcollation) WITH ORDINALITY AS indexed_collation(collation_oid, collation_position) ON indexed_collation.collation_position = indexed_key.key_position WHERE indexed_key.key_position <= ix.indnkeyatts ORDER BY indexed_key.key_position) AS "columnCollationsMatch" FROM pg_catalog.pg_index ix JOIN pg_catalog.pg_class tc ON tc.oid = ix.indrelid JOIN pg_catalog.pg_namespace n ON n.oid = tc.relnamespace JOIN pg_catalog.pg_class ic ON ic.oid = ix.indexrelid JOIN pg_catalog.pg_am am ON am.oid = ic.relam WHERE n.nspname = $1 AND tc.relname = $2 ORDER BY ic.relname',
    schema,
    "WebhookEventTrack",
  )
  requireMatch(Array.isArray(observedIndexes) && observedIndexes.length === indexes.length, "indexes")
  for (const [name, expectedColumns, unique] of indexes) {
    const rows = observedIndexes.filter((row) => row.name === name)
    const row = rows[0]
    const allTrueForEachKey = (values) =>
      Array.isArray(values) && values.length === expectedColumns.length && values.every((value) => value === true)
    requireMatch(
      rows.length === 1 &&
        row.unique === unique &&
        row.valid === true &&
        row.ready === true &&
        row.predicateIsNull === true &&
        row.noIncludeColumns === true &&
        row.noExpressions === true &&
        row.method === "btree" &&
        JSON.stringify(row.columns) === JSON.stringify(expectedColumns) &&
        allTrueForEachKey(row.defaultOrdering) &&
        allTrueForEachKey(row.defaultOperatorClasses) &&
        allTrueForEachKey(row.columnCollationsMatch),
      `index ${name}`,
    )
  }
  return true
}

export const WEBHOOK_CUTOVER_MIGRATION_NAMES = Object.freeze([...migrationNames])
export const WEBHOOK_CUTOVER_MIGRATION_CHECKSUMS = Object.freeze({ ...migrationChecksums })
