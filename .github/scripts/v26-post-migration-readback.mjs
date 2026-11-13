// Read-only, private post-migration evidence. Runtime principals must be
// independently derived from the actual running app, scanner and worker.
const expectedPolicies = {
  UserScanSlot: {
    name: "user_scan_slot_owner",
    expression:
      "(\"userId\" = NULLIF(current_setting('app.current_scan_user_id'::text, true), ''::text))",
  },
  ScanCapacityReservation: {
    name: "scan_capacity_account_owner",
    expression:
      "(\"accountId\" = NULLIF(current_setting('app.current_account_id'::text, true), ''::text))",
  },
}
const requiredMigrations = [
  "20261030103000_scan_admission_capacity",
  "20261030103100_scan_accounting_release",
  "20261030104500_fix_pr_execution_identity",
  "20261030110000_schedule_admission",
]

async function hasExpectedV26ColumnsAndIndex(client) {
  const columns = await client.query(`
    SELECT c.relname AS table_name, a.attname AS column_name,
      pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
    WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
      AND (c.relname, a.attname) IN (
        ('Scan','accountingVersion'),('Scan','accountingSettledAt'),
        ('PullRequest','executionKey'),('PullRequest','baseCommit'),('PullRequest','diffChecksum'),
        ('PullRequest','approvalId'),('PullRequest','requestedById'),('PullRequest','credentialActor'),
        ('Schedule','lastScanId'),('Schedule','lastBlockedAt'),('Schedule','lastBlockedReason'))`)
  const requiredColumns = {
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
  }
  if (
    columns.rows.length !== Object.keys(requiredColumns).length ||
    columns.rows.some(
      (row) => requiredColumns[`${row.table_name}.${row.column_name}`] !== row.data_type
    )
  )
    return false
  const index = await client.query(`
    SELECT i.indisunique, i.indisvalid, i.indisready, i.indpred IS NULL AS nonpartial,
      pg_catalog.pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='PullRequest_executionKey_key'`)
  if (
    index.rows?.length !== 1 ||
    index.rows[0].indisunique !== true ||
    index.rows[0].indisvalid !== true ||
    index.rows[0].indisready !== true ||
    index.rows[0].nonpartial !== true ||
    index.rows[0].definition !==
      'CREATE UNIQUE INDEX "PullRequest_executionKey_key" ON public."PullRequest" USING btree ("executionKey")'
  )
    return false

  return true
}

/** This result is evidence only. It cannot authorize admission by itself. */
export async function collectV26PostMigrationReadback(client, { principals, migrations }) {
  const failure = { status: "REVIEW_REQUIRED", cutoverReady: false }
  if (
    !Array.isArray(principals) ||
    principals.length === 0 ||
    principals.length > 16 ||
    principals.some((name) => typeof name !== "string" || !name || name.length > 63) ||
    new Set(principals).size !== principals.length ||
    !Array.isArray(migrations) ||
    migrations.length !== requiredMigrations.length ||
    migrations.some(
      (item) =>
        !item ||
        !requiredMigrations.includes(item.name) ||
        !/^[a-f0-9]{64}$/.test(item.checksum ?? "")
    ) ||
    new Set(migrations.map((item) => item.name)).size !== requiredMigrations.length
  )
    return failure

  let began = false
  let result = failure
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    began = true
    await client.query("SET LOCAL statement_timeout = '10s'")
    await client.query("SET LOCAL row_security = off")
    const role = await client.query(
      "SELECT r.rolsuper OR r.rolbypassrls AS global_read FROM pg_catalog.pg_roles r WHERE r.rolname = current_user"
    )
    if (role.rows?.length !== 1 || role.rows[0].global_read !== true) return failure

    const recorded = await client.query(
      'SELECT migration_name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back FROM public."_prisma_migrations" WHERE migration_name = ANY($1::text[])',
      [migrations.map((item) => item.name)]
    )
    if (
      recorded.rows.length !== requiredMigrations.length ||
      migrations.some((expected) => {
        const matches = recorded.rows.filter((row) => row.migration_name === expected.name)
        return (
          matches.length !== 1 ||
          matches[0].checksum !== expected.checksum ||
          matches[0].finished !== true ||
          matches[0].rolled_back !== false
        )
      })
    )
      return failure

    if (!(await hasExpectedV26ColumnsAndIndex(client))) return failure

    const tables = await client.query(
      `
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, p.polname, p.polcmd,
        p.polpermissive, p.polroles::text AS roles,
        pg_catalog.pg_get_expr(p.polqual,p.polrelid) AS using_expression,
        pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid) AS check_expression
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_catalog.pg_policy p ON p.polrelid = c.oid
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) AND c.relkind = 'r'`,
      [Object.keys(expectedPolicies)]
    )
    if (tables.rows.length !== 2) return failure
    for (const row of tables.rows) {
      const expected = expectedPolicies[row.relname]
      if (
        !expected ||
        row.relrowsecurity !== true ||
        row.relforcerowsecurity !== true ||
        row.polname !== expected.name ||
        row.polcmd !== "*" ||
        row.polpermissive !== true ||
        row.roles !== "{0}" ||
        row.using_expression !== expected.expression ||
        row.check_expression !== expected.expression
      )
        return failure
    }

    const grants = await client.query(
      `
      SELECT r.rolname, r.rolsuper, r.rolbypassrls,
        bool_and(pg_catalog.has_table_privilege(r.oid, c.oid, 'SELECT')
          AND pg_catalog.has_table_privilege(r.oid, c.oid, 'INSERT')
          AND pg_catalog.has_table_privilege(r.oid, c.oid, 'UPDATE')
          AND pg_catalog.has_table_privilege(r.oid, c.oid, 'DELETE')) AS crud
      FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE r.rolname = ANY($1::text[]) AND n.nspname = 'public'
        AND c.relname = ANY($2::text[]) AND c.relkind = 'r'
      GROUP BY r.rolname, r.rolsuper, r.rolbypassrls`,
      [principals, Object.keys(expectedPolicies)]
    )
    if (
      grants.rows.length !== principals.length ||
      grants.rows.some(
        (row) => row.rolsuper !== false || row.rolbypassrls !== false || row.crud !== true
      )
    )
      return failure

    const counts = await client.query(`
      SELECT (SELECT count(*) FROM public."UserScanSlot") AS slots,
             (SELECT count(*) FROM public."ScanCapacityReservation") AS reservations`)
    if (
      counts.rows?.length !== 1 ||
      counts.rows[0].slots !== "0" ||
      counts.rows[0].reservations !== "0"
    )
      return failure
    result = { status: "NO_DETECTED_DB_BLOCKERS", cutoverReady: false }
  } catch {
    result = failure
  } finally {
    if (began) {
      try {
        await client.query("ROLLBACK")
      } catch {
        result = failure
      }
    }
  }
  return result
}
