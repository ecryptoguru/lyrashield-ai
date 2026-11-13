import { createHash } from "node:crypto"

export const fingerprint = (value) => createHash("sha256").update(value).digest("hex")

// Run on the actual connected endpoint; URL usernames are not role attestations.
export async function observeRuntimeDatabase(client, { runtime = true } = {}) {
  const result =
    await client.query(`SELECT current_user AS principal, current_database() AS database,
    d.oid::text AS database_oid, inet_server_addr()::text AS server,
    current_schema() AS schema, r.rolsuper, r.rolbypassrls
    FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_database d
    WHERE r.rolname=current_user AND d.datname=current_database()`)
  const row = result.rows?.[0]
  if (
    result.rows?.length !== 1 ||
    !row.principal ||
    !row.database ||
    !row.database_oid ||
    !row.server ||
    row.schema !== "public" ||
    (runtime && (row.rolsuper !== false || row.rolbypassrls !== false))
  )
    throw new Error("Runtime database identity or least privilege unavailable")
  return {
    principal: row.principal,
    databaseIdentity: fingerprint(
      JSON.stringify([row.database, row.database_oid, row.server, row.schema])
    ),
  }
}

// Callers must bind these names to observeRuntimeDatabase on the actual app,
// scanner and worker connections before passing them here. No environment role lists.
export async function grantV26RuntimeTables(client, principals) {
  if (
    !Array.isArray(principals) ||
    principals.length < 1 ||
    principals.length > 16 ||
    principals.some((value) => typeof value !== "string" || !value || Buffer.byteLength(value) > 63)
  )
    throw new Error("Invalid observed runtime principals")
  const names = [...new Set(principals)]
  await client.query("BEGIN")
  try {
    await client.query("SET LOCAL statement_timeout = '10s'")
    const roles = await client.query(
      "SELECT rolname, rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
      [names]
    )
    if (
      roles.rows.length !== names.length ||
      roles.rows.some((row) => row.rolsuper !== false || row.rolbypassrls !== false)
    )
      throw new Error("Runtime role privileges changed")
    for (const name of names) {
      const quoted = '"' + name.replaceAll('"', '""') + '"'
      // Identifiers come exclusively from verified catalog observations; quote
      // every identifier rather than treating a role name as SQL syntax.
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."UserScanSlot", public."ScanCapacityReservation" TO ${quoted}`
      )
    }
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  }
}

// Adjacent GitHub mutation executors can outlive empty scan/fix queues.
// Keep their historical failures intact; only EXECUTING is a live blocker.
export async function assertNoAdjacentExecutions(client) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
  try {
    await client.query("SET LOCAL statement_timeout = '10s'")
    await client.query("SET LOCAL row_security = off")
    const role = await client.query(
      "SELECT rolsuper OR rolbypassrls AS global_read FROM pg_catalog.pg_roles WHERE rolname=current_user"
    )
    if (role.rows?.length !== 1 || role.rows[0].global_read !== true)
      throw new Error("Adjacent execution visibility unavailable")
    const result = await client.query(`SELECT
      (SELECT count(*)::text FROM public."AgentApproval" WHERE status = 'EXECUTING') AS approvals,
      (SELECT count(*)::text FROM public.agent_operations WHERE status = 'EXECUTING') AS operations,
      (SELECT count(*)::text FROM public."WebhookEventTrack" WHERE status NOT IN ('succeeded','dead_letter','reviewed')) AS webhook_tracks`)
    if (
      result.rows?.length !== 1 ||
      result.rows[0].approvals !== "0" ||
      result.rows[0].operations !== "0" ||
      result.rows[0].webhook_tracks !== "0"
    )
      throw new Error("Adjacent mutation execution remains unresolved")
  } finally {
    await client.query("ROLLBACK")
  }
}
