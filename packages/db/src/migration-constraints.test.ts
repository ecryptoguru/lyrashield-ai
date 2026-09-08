import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

function migration(path: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(new URL(path, import.meta.url), "utf8")
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
})
