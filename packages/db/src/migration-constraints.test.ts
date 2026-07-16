import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

function migration(path: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

describe("forward database constraints", () => {
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
})
