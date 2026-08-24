#!/usr/bin/env node

import pg from "pg"

const { Client } = pg
const RUNTIME_ROLE = "app_runtime_staging"
const SYSTEM_ROLE = "app_system_staging"
const SYSTEM_TABLES = ["License", "LicenseKey", "LicenseActivation"]
const SYSTEM_PRIVILEGES = new Set([
  "License:SELECT",
  "License:INSERT",
  "License:UPDATE",
  "License:DELETE",
  "LicenseKey:SELECT",
  "LicenseKey:INSERT",
  "LicenseKey:UPDATE",
  "LicenseActivation:SELECT",
  "LicenseActivation:INSERT",
  "LicenseActivation:UPDATE",
])

function required(name, trim = true) {
  const raw = process.env[name]
  const value = trim ? raw?.trim() : raw
  if (!value) throw new Error(`${name} is required`)
  return value
}

function roleUrl(adminUrl, role, password) {
  const url = new URL(adminUrl)
  url.username = role
  url.password = password
  return url.toString()
}

async function setLoginRole(client, role, password) {
  const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])
  const action = exists.rowCount === 1 ? "ALTER" : "CREATE"
  const statement = await client.query(
    `SELECT format('${action} ROLE ${role} LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', $1::text) AS sql`,
    [password]
  )
  await client.query(statement.rows[0].sql)
}

async function assertRestrictedRole(client, role) {
  const result = await client.query(
    `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit, rolreplication
       FROM pg_roles WHERE rolname = $1`,
    [role]
  )
  const row = result.rows[0]
  if (
    !row ||
    row.rolsuper ||
    row.rolbypassrls ||
    row.rolcreatedb ||
    row.rolcreaterole ||
    row.rolinherit ||
    row.rolreplication
  ) {
    throw new Error(`${role} has elevated role attributes`)
  }

  const memberships = await client.query(
    `SELECT 1
       FROM pg_auth_members AS membership
       JOIN pg_roles AS member_role ON member_role.oid = membership.member
       JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
      WHERE member_role.rolname = $1 OR granted_role.rolname = $1`,
    [role]
  )
  if (memberships.rowCount !== 0) {
    throw new Error(`${role} must not have role memberships`)
  }
}

async function provision() {
  const adminUrl = required("DATABASE_ADMIN_URL")
  const runtimePassword = required("RUNTIME_PASSWORD", false)
  const systemPassword = required("SYSTEM_PASSWORD", false)
  const admin = new Client({ connectionString: adminUrl })
  await admin.connect()

  try {
    await setLoginRole(admin, RUNTIME_ROLE, runtimePassword)
    await setLoginRole(admin, SYSTEM_ROLE, systemPassword)

    await admin.query(`DO $grant$ BEGIN
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${RUNTIME_ROLE}, ${SYSTEM_ROLE}', current_database());
    END $grant$;`)
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE}, ${SYSTEM_ROLE}`)

    await admin.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${RUNTIME_ROLE}`)
    await admin.query(
      `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${RUNTIME_ROLE}`
    )
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RUNTIME_ROLE}`
    )
    await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RUNTIME_ROLE}`)
    await admin.query(
      `REVOKE ALL PRIVILEGES ON TABLE "PlatformAdminElevation", "PlatformAdminChallengeLimit", "PlatformAdminAudit" FROM ${RUNTIME_ROLE}`
    )

    await admin.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${SYSTEM_ROLE}`)
    await admin.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${SYSTEM_ROLE}`)
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "License" TO ${SYSTEM_ROLE}`)
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE ON TABLE "LicenseKey", "LicenseActivation" TO ${SYSTEM_ROLE}`
    )

    for (const table of SYSTEM_TABLES) {
      const policy = `billing_staging_system_${table.toLowerCase()}`
      await admin.query(`DROP POLICY IF EXISTS ${policy} ON "${table}"`)
      await admin.query(
        `CREATE POLICY ${policy} ON "${table}" FOR ALL TO ${SYSTEM_ROLE} USING (true) WITH CHECK (true)`
      )
    }

    await assertRestrictedRole(admin, RUNTIME_ROLE)
    await assertRestrictedRole(admin, SYSTEM_ROLE)

    const effectiveSystemPrivileges = await admin.query(
      `SELECT tables.table_name, privilege
         FROM information_schema.tables AS tables
        CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS privilege
        WHERE tables.table_schema = 'public'
          AND has_table_privilege($1, format('%I.%I', tables.table_schema, tables.table_name), privilege)`,
      [SYSTEM_ROLE]
    )
    const actualPrivileges = new Set(
      effectiveSystemPrivileges.rows.map((row) => `${row.table_name}:${row.privilege}`)
    )
    if (
      actualPrivileges.size !== SYSTEM_PRIVILEGES.size ||
      [...SYSTEM_PRIVILEGES].some((privilege) => !actualPrivileges.has(privilege))
    ) {
      throw new Error(`${SYSTEM_ROLE} privileges do not match the exact license-table contract`)
    }

    const system = new Client({
      connectionString: roleUrl(adminUrl, SYSTEM_ROLE, systemPassword),
    })
    await system.connect()
    try {
      await system.query('SELECT 1 FROM "License" LIMIT 0')
      try {
        await system.query('SELECT 1 FROM "Workspace" LIMIT 0')
        throw new Error(`${SYSTEM_ROLE} can read Workspace`)
      } catch (error) {
        if (error?.code !== "42501") throw error
      }
    } finally {
      await system.end()
    }
  } finally {
    await admin.end()
  }
}

provision().catch((error) => {
  console.error(error instanceof Error ? error.message : "role provisioning failed")
  process.exit(1)
})
