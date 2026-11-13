import { afterEach, expect, it, vi } from "vitest"
import type pg from "pg"

// Isolate the SQL fixture boundary from unrelated plan, broker and queue setup.
vi.mock("../../src/scan-execution-plan", () => ({ computeScanExecutionPlanHash: vi.fn() }))
vi.mock("../../src/scan-dispatch-authority-broker-methods", () => ({ commandDigest: vi.fn() }))
vi.mock("./queue-outbox-fixture", () => ({ publishFixtureOutbox: vi.fn() }))

import {
  insertPreparationAttempt,
  installPreparationFixtureRole,
  installPreparationRevokerRole,
  type PreparationFixture,
} from "./scan-preparation-fixture"

afterEach(() => vi.unstubAllEnvs())

const f: PreparationFixture = {
  userId: "fixture-user",
  workspaceId: "fixture-workspace",
  targetId: "fixture-target",
  scanId: "fixture-scan",
  operationId: "fixture-operation",
  grantId: "fixture-grant",
  epochId: "fixture-epoch",
  instanceId: "fixture-instance",
}

it("binds caller metadata as values and never treats it as SQL", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
  const transactionId = "'; DROP TABLE fixture; --"
  const acceptedAt = new Date("2026-11-11T10:00:00Z")
  const expiresAt = new Date("2026-11-11T10:01:00Z")
  await insertPreparationAttempt({ query } as unknown as pg.PoolClient, f, {
    expiresAt,
    authorityMetadata: {
      authorityAcceptedAt: acceptedAt,
      authorityTransactionId: transactionId,
      authorityDeadlineAt: "infinity",
    },
  })
  const [sql, values] = query.mock.calls[0]
  expect(sql).not.toContain(transactionId)
  expect(sql).toContain("$7::timestamp,$8::text,$9::timestamp")
  expect(values).toEqual([
    f.operationId,
    `${f.operationId}-attempt`,
    f.epochId,
    f.grantId,
    f.scanId,
    expiresAt,
    acceptedAt,
    transactionId,
    "infinity",
  ])
})

it("keeps historical insertion usable before metadata columns exist", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
  await insertPreparationAttempt({ query } as unknown as pg.PoolClient, f)
  const [sql, values] = query.mock.calls[0]
  expect(sql).not.toContain('"authorityAcceptedAt"')
  expect(sql).not.toContain('"authorityTransactionId"')
  expect(sql).not.toContain('"authorityDeadlineAt"')
  expect(values).toEqual([
    f.operationId,
    `${f.operationId}-attempt`,
    f.epochId,
    f.grantId,
    f.scanId,
    null,
  ])
})

it.each([installPreparationFixtureRole, installPreparationRevokerRole])(
  "requires disposable confirmation before any role operation (%s)",
  async (install) => {
    vi.stubEnv("LYRASHIELD_TEST_DB_DISPOSABLE", "0")
    const query = vi.fn()
    await expect(install({ query } as unknown as pg.Pool)).rejects.toThrow(
      "Disposable fixture required"
    )
    expect(query).not.toHaveBeenCalled()
  }
)

it.each([
  "",
  "a".repeat(47),
  "a".repeat(49),
  "A".repeat(48),
  "a".repeat(47) + "'",
  "a".repeat(48) + "\n",
  "a".repeat(48) + "\r\n",
])("rejects malformed role credentials before CREATE/GRANT (%s)", async (password) => {
  vi.stubEnv("LYRASHIELD_TEST_DB_DISPOSABLE", "1")
  vi.stubEnv("DISPATCH_PREPARATION_BROKER_PASSWORD", password)
  vi.stubEnv("DISPATCH_AUTHORITY_REVOKER_PASSWORD", password)
  for (const install of [installPreparationFixtureRole, installPreparationRevokerRole]) {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await expect(install({ query } as unknown as pg.Pool)).rejects.toThrow("password unavailable")
    expect(
      query.mock.calls.every(
        ([sql]) => sql === "SELECT 1 FROM pg_roles WHERE rolname='dispatch_prepare_broker'"
      )
    ).toBe(true)
  }
})
