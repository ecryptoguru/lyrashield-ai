#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import pg from "pg"

const { Client } = pg
const MIGRATION = "20260814020000_ai_system_profile_versions"

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function verifyStaleRecord(client) {
  const migration = await client.query(
    `SELECT finished_at, rolled_back_at, applied_steps_count
       FROM "_prisma_migrations"
      WHERE migration_name = $1`,
    [MIGRATION]
  )
  if (
    migration.rowCount !== 1 ||
    migration.rows[0].finished_at !== null ||
    migration.rows[0].rolled_back_at !== null ||
    Number(migration.rows[0].applied_steps_count) !== 0
  ) {
    throw new Error("staging migration record is not the expected unresolved failure")
  }

  const schema = await client.query(
    `SELECT
       to_regclass('public."AiSystemProfile"') IS NOT NULL AS has_profile_table,
       EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'AiSystemProfile'
            AND column_name = 'currentVersionId'
       ) AS has_current_version_id,
       to_regclass('public."AiSystemProfileVersion"') IS NOT NULL AS has_version_table`
  )
  if (
    !schema.rows[0].has_profile_table ||
    schema.rows[0].has_current_version_id ||
    schema.rows[0].has_version_table
  ) {
    throw new Error(
      "staging schema contains migration effects; refusing to rewrite migration history"
    )
  }
}

async function recover() {
  const adminUrl = required("DATABASE_ADMIN_URL")
  if (required("BILLING_STAGING_RECOVER_MIGRATION") !== MIGRATION) {
    throw new Error("unsupported staging migration recovery request")
  }

  const client = new Client({ connectionString: adminUrl })
  await client.connect()
  try {
    await verifyStaleRecord(client)
  } finally {
    await client.end()
  }

  execFileSync(
    "pnpm",
    [
      "--filter",
      "@lyrashield/db",
      "exec",
      "prisma",
      "migrate",
      "resolve",
      "--rolled-back",
      MIGRATION,
    ],
    {
      cwd: "/app",
      env: { ...process.env, DATABASE_URL: adminUrl, DATABASE_DIRECT_URL: adminUrl },
      stdio: "inherit",
    }
  )
}

recover().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "billing staging migration recovery failed"
  )
  process.exit(1)
})
