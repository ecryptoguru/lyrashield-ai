import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8")
const migrationUrl = new URL(
  "../prisma/migrations/20261105130000_durable_dispatch_authority/migration.sql",
  import.meta.url
)
const migrationExists = existsSync(migrationUrl)
const sql = migrationExists ? readFileSync(migrationUrl, "utf8") : ""

describe("durable scan dispatch authority schema", () => {
  it("declares the closed authority foundation without runtime producers", () => {
    expect(migrationExists).toBe(true)
    for (const model of [
      "ScanAuthorityEpoch",
      "ScanWorkerInstanceGrant",
      "ScanDispatchAttempt",
      "ScanDispatchOutbox",
      "ScanPhysicalExecution",
      "ScanPhysicalExecutionTransition",
    ]) {
      expect(schema).toContain(`model ${model} `)
    }
    expect(schema).toMatch(/isOpen\s+Boolean\s+@default\(false\)/)
  })

  it("keeps attempt identity immutable and operation commands unique", () => {
    expect(sql).toContain('CREATE TABLE "ScanDispatchAttempt"')
    expect(sql).toContain("CREATE TRIGGER scan_dispatch_attempt_immutable")
    expect(sql).toContain('CREATE UNIQUE INDEX "ScanDispatchOutbox_operationId_commandType_key"')
    expect(sql).toContain('"commandDigest" TEXT NOT NULL')
    expect(sql).not.toMatch(/"commandPayload"|raw credential|raw token/i)
  })

  it("enforces one unresolved physical attempt per scan", () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "ScanPhysicalExecution_unresolvedKey_key"')
    expect(sql).toContain(
      "'RESERVED', 'DISPATCH_PENDING', 'ACTIVE', 'STOP_REQUESTED', 'CLEANUP_PENDING', 'UNKNOWN'"
    )
  })

  it("keeps physical revisions monotonic and gates UNKNOWN resolution", () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "ScanPhysicalExecutionTransition_attemptId_revision_key"'
    )
    expect(sql).toContain("scan_physical_execution_transition_guard")
    expect(sql).toContain("terminal physical release requires acknowledged supervisor evidence")
    expect(sql).toContain("unknown command lacks physical quarantine")
    expect(sql).toContain("unknown physical execution reconciliation is unverified")
    expect(sql).toContain("CREATE TRIGGER scan_physical_execution_transition_guard")
    expect(sql).toContain("CREATE TRIGGER scan_physical_execution_immutable_state")
  })

  it("requires an open epoch and a matching live worker grant for attempts", () => {
    expect(sql).toContain("attempt requires an open authority epoch")
    expect(sql).toContain("attempt requires a live worker grant in its epoch")
    expect(sql).toContain("physical execution identity contradicts its attempt")
    expect(sql).toContain('FOREIGN KEY ("operationId", "attemptId")')
  })

  it("stores only hashes for worker instance credentials", () => {
    expect(sql).toContain('"credentialHash" TEXT NOT NULL')
    expect(sql).toContain('CREATE UNIQUE INDEX "ScanWorkerInstanceGrant_credentialHash_key"')
    expect(sql).not.toMatch(/"credential"|"token"|"secret"/i)
  })

  it("seeds a closed monotonic authority epoch", () => {
    expect(sql).toContain('INSERT INTO "ScanAuthorityEpoch"')
    expect(sql).toContain("scan_authority_epoch_monotonic")
    expect(sql).toContain('CREATE UNIQUE INDEX "ScanAuthorityEpoch_openKey_key"')
    expect(sql).toContain("scan_authority_epoch_closed_default")
  })
})
