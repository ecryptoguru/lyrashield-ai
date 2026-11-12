// Read-only compatibility evidence for the new web producer. The retained
// worker does not consume this table and receives no new privilege here.
export async function verifyRetainedRuntimeSchema(client, { principals, migration }) {
  if (
    !Array.isArray(principals) ||
    principals.length < 1 ||
    principals.length > 16 ||
    new Set(principals).size !== principals.length ||
    principals.some((name) => typeof name !== "string" || !name || Buffer.byteLength(name) > 63) ||
    migration?.name !== "20261105120000_delegated_scan_provenance" ||
    !/^[a-f0-9]{64}$/.test(migration?.checksum ?? "")
  )
    throw new Error("Retained runtime schema input unavailable")

  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
  try {
    await client.query("SET LOCAL statement_timeout = '10s'")
    const recorded = await client.query(
      'SELECT checksum, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back FROM public."_prisma_migrations" WHERE migration_name = $1',
      [migration.name]
    )
    if (
      recorded.rows?.length !== 1 ||
      recorded.rows[0].checksum !== migration.checksum ||
      recorded.rows[0].finished !== true ||
      recorded.rows[0].rolled_back !== false
    )
      throw new Error("Retained runtime migration unavailable")

    const policies = await client.query(`
      SELECT c.relrowsecurity, c.relforcerowsecurity, p.polname, p.polcmd,
        p.polpermissive, p.polroles::text AS roles,
        pg_catalog.pg_get_expr(p.polqual,p.polrelid) AS using_expression,
        pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid) AS check_expression
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_catalog.pg_policy p ON p.polrelid=c.oid
      WHERE n.nspname='public' AND c.relname='delegated_scan_provenance' AND c.relkind='r'`)
    const policy = policies.rows?.[0]
    const expression = '("workspaceId" = app.current_workspace_id())'
    if (
      policies.rows?.length !== 1 ||
      policy.relrowsecurity !== true ||
      policy.relforcerowsecurity !== true ||
      policy.polname !== "delegated_scan_provenance_workspace" ||
      policy.polcmd !== "*" ||
      policy.polpermissive !== true ||
      policy.roles !== "{0}" ||
      policy.using_expression !== expression ||
      policy.check_expression !== expression
    )
      throw new Error("Retained runtime provenance isolation unavailable")

    const triggers = await client.query(`
      SELECT t.tgname, t.tgtype, t.tgenabled, t.tgqual IS NULL AS unconditional,
        pn.nspname AS function_schema, p.proname, p.pronargs, p.prosecdef,
        p.prorettype='pg_catalog.trigger'::regtype AS returns_trigger, p.prosrc
      FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
      JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
      WHERE n.nspname='public' AND c.relname='delegated_scan_provenance'
        AND NOT t.tgisinternal`)
    const trigger = triggers.rows?.[0]
    if (
      triggers.rows?.length !== 1 ||
      trigger.tgname !== "delegated_scan_provenance_immutable" ||
      trigger.tgtype !== 19 ||
      trigger.tgenabled !== "O" ||
      trigger.unconditional !== true ||
      trigger.function_schema !== "app" ||
      trigger.proname !== "reject_delegated_scan_provenance_update" ||
      trigger.pronargs !== 0 ||
      trigger.prosecdef !== false ||
      trigger.returns_trigger !== true ||
      trigger.prosrc?.trim() !==
        "BEGIN\n  RAISE EXCEPTION 'delegated scan provenance is immutable' USING ERRCODE = '23514';\nEND;"
    )
      throw new Error("Retained runtime provenance immutability unavailable")

    const grants = await client.query(
      `SELECT r.rolname, r.rolsuper, r.rolbypassrls,
        pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT') AS can_select,
        pg_catalog.has_table_privilege(r.oid,c.oid,'INSERT') AS can_insert,
        pg_catalog.has_table_privilege(r.oid,c.oid,'DELETE') AS can_delete
      FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE r.rolname=ANY($1::text[]) AND n.nspname='public'
        AND c.relname='delegated_scan_provenance' AND c.relkind='r'`,
      [principals]
    )
    if (
      grants.rows?.length !== principals.length ||
      new Set(grants.rows.map((row) => row.rolname)).size !== principals.length ||
      grants.rows.some(
        (row) =>
          !principals.includes(row.rolname) ||
          row.rolsuper !== false ||
          row.rolbypassrls !== false ||
          row.can_select !== true ||
          row.can_insert !== true ||
          row.can_delete !== false
      )
    )
      throw new Error("Retained runtime provenance access unavailable")
  } finally {
    await client.query("ROLLBACK")
  }
}
