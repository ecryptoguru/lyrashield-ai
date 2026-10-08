import { readFileSync, readdirSync } from "node:fs"
import { describe, expect, it } from "vitest"

function migration(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

const migrationsDir = new URL("../prisma/migrations/", import.meta.url)

function migrationDirectoryNames(): string[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

describe("forward database constraints", () => {
  it("keeps agent connection and operation RLS closed without workspace context", () => {
    const sql = migration(
      "../prisma/migrations/20260908120000_agent_connections_operations/migration.sql"
    )
    expect(sql).not.toMatch(/current_workspace_id\(\)\s+IS\s+NULL/i)
    expect(sql).toContain('"workspaceId" = app.current_workspace_id()')
    expect(sql).toContain('ALTER TABLE "agent_connections" FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('ALTER TABLE "agent_operations" FORCE ROW LEVEL SECURITY')
  })

  it("constrains GitHub installation identifiers to positive decimal values", () => {
    const sql = migration(
      "../prisma/migrations/20260716150000_integration_external_id_check/migration.sql"
    )

    expect(sql).toContain("\"type\" <> 'GITHUB'")
    expect(sql).toContain("\"externalId\" ~ '^[1-9][0-9]*$'")
    expect(sql).toContain('VALIDATE CONSTRAINT "Integration_github_externalId_format_check"')
  })

  it("allows only one active public share for a score snapshot", () => {
    const sql = migration(
      "../prisma/migrations/20260716151000_scorecard_share_active_snapshot_unique/migration.sql"
    )

    expect(sql).toContain('CREATE UNIQUE INDEX "ScorecardShare_snapshotId_active_key"')
    expect(sql).toContain('WHERE "revokedAt" IS NULL')
  })

  it("denies the production runtime role access to global admin authority tables", () => {
    const sql = migration("../prisma/migrations/20260824090000_platform_admin_totp/migration.sql")

    for (const table of [
      "PlatformAdminElevation",
      "PlatformAdminChallengeLimit",
      "PlatformAdminAudit",
    ]) {
      expect(sql).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`)
      expect(sql).toContain(`REVOKE ALL PRIVILEGES ON TABLE "${table}" FROM app_runtime_prod`)
    }
  })

  it("adds every OAuth Provider 1.7 dynamic-registration field", () => {
    const sql = migration(
      "../prisma/migrations/20260908043000_oauth_client_provider_fields/migration.sql"
    )

    for (const column of [
      "clientDiscoveryId",
      "clientCredentialsScopes",
      "expiresAt",
      "applicationType",
    ]) {
      expect(sql).toContain(`ADD COLUMN "${column}"`)
    }
    expect(sql).toContain('"clientCredentialsScopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]')
  })

  it("adds the execution plan columns additively without touching Scan RLS", () => {
    const sql = migration("../prisma/migrations/20260919000000_scan_execution_plan/migration.sql")
    expect(sql).toContain('ALTER TABLE "Scan" ADD COLUMN')
    expect(sql).toContain('"executionPlan" JSONB')
    expect(sql).toContain('"executionPlanHash" TEXT')
    // Rollback-compatible: nullable columns only — no RLS/policy/privilege
    // changes and no NOT NULL that would break readers on the prior schema.
    expect(sql).not.toMatch(
      /ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY|REVOKE|GRANT|NOT NULL|DROP /i
    )
  })

  it("adds nullable manifest checksum input without backfilling legacy rows", () => {
    const sql = migration(
      "../prisma/migrations/20260927000000_manifest_checksum_input/migration.sql"
    )
    expect(sql).toContain('ALTER TABLE "ScanResultManifest" ADD COLUMN "checksumInput" TEXT')
    expect(sql).not.toMatch(/UPDATE\s+"ScanResultManifest"|NOT NULL|DEFAULT|DROP /i)
  })

  it("keeps Myra generation reservations restricted to unbound service work", () => {
    const sql = migration("../prisma/migrations/20260915000000_myra_support_agent/migration.sql")
    expect(sql).toContain('ALTER TABLE "myra_generation_reservations" FORCE ROW LEVEL SECURITY')
    expect(sql).toContain("CREATE POLICY myra_generation_reservations_unbound")
    expect(sql).toContain("myra_generation_reservations_status_check")
    expect(sql).toContain("myra_generation_reservations_reserved_nonnegative")
    expect(sql).toContain(
      "app.current_account_id() IS NULL AND app.myra_public_session_id() IS NULL"
    )
  })
})

// P2-16 originally shipped two indexes in two separately approvable migrations:
// the AUDITED minute-pack partial index and an OPTIONAL WebhookEvent composite.
// The optional half was DROPPED by founder decision on 2026-10-09 — the daily
// settlement-receipt probe gains under 100 ms at 200,000 rows, which does not
// justify an extra b-tree insert on the billing table yet. Revisit when
// WebhookEvent reaches the hundreds of thousands of rows or the reconciliation
// job duration starts climbing.
//
// These assertions pin the surviving shape: the audited migration is present and
// correct, the optional migration is GONE, and the schema carries no matching
// WebhookEvent declaration. That last pair is what stops the dropped index from
// being reintroduced by a stray merge.
describe("P2-16 migration structure", () => {
  const auditedDir = "20261008120000_p2_16_minute_pack_expiry_index"
  const droppedDir = "20261008130000_p2_16_webhook_event_integrity_index"
  const all = migrationDirectoryNames()
  const auditedSql = migration(`../prisma/migrations/${auditedDir}/migration.sql`)
  const schema = migration("../prisma/schema.prisma")

  function executableStatements(sql: string): string[] {
    // Comments carry the reasoning; only the executable statements are asserted on.
    return sql
      .replace(/--[^\n]*/g, "")
      .split(";")
      .filter((statement) => statement.trim())
  }

  it("carries the audited minute-pack index in its own migration", () => {
    expect(auditedSql).toContain(
      'CREATE INDEX CONCURRENTLY "MinutePack_expiresAt_active_partial_idx"'
    )
    expect(auditedSql).toContain('WHERE "remainingMinutes" > 0 AND "deletedAt" IS NULL')
    // The dropped index must never be smuggled into the audited migration.
    expect(auditedSql).not.toContain("WebhookEvent_provider_eventType_createdAt_idx")
  })

  it("creates exactly one index in the audited migration and nothing else", () => {
    const statements = executableStatements(auditedSql)
    expect(statements).toHaveLength(1)
    const executable = statements[0] ?? ""
    expect(executable).toMatch(/^\s*CREATE INDEX CONCURRENTLY\b/)
    // Additive only: no drops, renames, column changes or data changes.
    expect(executable).not.toMatch(
      /\bDROP\b|\bRENAME\b|\bALTER\b|\bDELETE\b|\bUPDATE\b|\bINSERT\b/i
    )
    // Forward-only: no down step to run.
    expect(auditedSql).not.toMatch(/\bDROP INDEX\b/i)
    expect(auditedDir).toMatch(/^[0-9]{14}_[a-z0-9_]+$/)
  })

  it("places the audited migration after every migration that already exists", () => {
    const preexisting = all.filter((name) => name !== auditedDir)
    const highestPreexisting = preexisting[preexisting.length - 1] ?? ""
    expect(auditedDir > highestPreexisting).toBe(true)
    // PR #964 owns this one. The audited migration must sort after it so the
    // Myra RLS boundary always applies first.
    expect(auditedDir > "20261007170000_myra_public_session_rls_boundary").toBe(true)
  })

  it("ships no webhook-index migration", () => {
    expect(all).not.toContain(droppedDir)
  })

  it("declares no WebhookEvent provider/eventType/createdAt index in the schema", () => {
    expect(schema).not.toContain("WebhookEvent_provider_eventType_createdAt")
    expect(schema).not.toContain("@@index([provider, eventType, createdAt])")
  })
})
