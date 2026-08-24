#!/usr/bin/env node

import pg from "pg"

const { Client } = pg
const E2E_ROLE = "billing_e2e_staging"

function required(name, trim = true) {
  const raw = process.env[name]
  const value = trim ? raw?.trim() : raw
  if (!value) throw new Error(`${name} is required`)
  return value
}

function roleUrl(adminUrl, password) {
  const url = new URL(adminUrl)
  url.username = E2E_ROLE
  url.password = password
  return url.toString()
}

async function assertEvidenceRole(client) {
  const result = await client.query(
    `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit, rolreplication
       FROM pg_roles WHERE rolname = $1`,
    [E2E_ROLE]
  )
  const row = result.rows[0]
  if (
    !row ||
    row.rolsuper ||
    !row.rolbypassrls ||
    row.rolcreatedb ||
    row.rolcreaterole ||
    row.rolinherit ||
    row.rolreplication
  ) {
    throw new Error(`${E2E_ROLE} does not match the disposable evidence role contract`)
  }

  const memberships = await client.query(
    `SELECT 1
       FROM pg_auth_members AS membership
       JOIN pg_roles AS member_role ON member_role.oid = membership.member
       JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
      WHERE member_role.rolname = $1 OR granted_role.rolname = $1`,
    [E2E_ROLE]
  )
  if (memberships.rowCount !== 0) {
    throw new Error(`${E2E_ROLE} must not have role memberships`)
  }
}

async function provision(client, adminUrl) {
  const password = required("E2E_PASSWORD", false)
  const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [E2E_ROLE])
  const action = exists.rowCount === 1 ? "ALTER" : "CREATE"
  const statement = await client.query(
    `SELECT format('${action} ROLE ${E2E_ROLE} LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS', $1::text) AS sql`,
    [password]
  )
  await client.query(statement.rows[0].sql)
  await client.query(`DO $grant$ BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${E2E_ROLE}', current_database());
  END $grant$;`)
  await client.query(`GRANT USAGE ON SCHEMA public TO ${E2E_ROLE}`)
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${E2E_ROLE}`
  )
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${E2E_ROLE}`)
  await assertEvidenceRole(client)

  const evidence = new Client({ connectionString: roleUrl(adminUrl, password) })
  await evidence.connect()
  try {
    await evidence.query("SELECT 1")
  } finally {
    await evidence.end()
  }
}

async function drop(client) {
  const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [E2E_ROLE])
  if (exists.rowCount === 0) return

  await client.query(`DO $revoke$ BEGIN
    EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM ${E2E_ROLE}', current_database());
  END $revoke$;`)
  await client.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()",
    [E2E_ROLE]
  )
  await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${E2E_ROLE}`)
  await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${E2E_ROLE}`)
  await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${E2E_ROLE}`)
  await client.query(`DROP ROLE ${E2E_ROLE}`)
}

async function main() {
  const action = required("E2E_ROLE_ACTION")
  if (action !== "provision" && action !== "drop") {
    throw new Error("E2E_ROLE_ACTION must be provision or drop")
  }

  const adminUrl = required("DATABASE_ADMIN_URL")
  const client = new Client({ connectionString: adminUrl })
  await client.connect()
  try {
    if (action === "provision") await provision(client, adminUrl)
    else await drop(client)
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "E2E role operation failed")
  process.exit(1)
})
