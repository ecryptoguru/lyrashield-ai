import type pg from "pg"
import { describe, expect, it, vi } from "vitest"
import { applyAuthenticatedCleanup } from "./scan-supervisor-cleanup-projection"

function fixture(patch: Record<string, unknown> = {}) {
  const query = vi.fn().mockResolvedValue({ rows: [] })
  query.mockResolvedValueOnce({
    rows: [
      {
        state: "UNKNOWN",
        revision: 3,
        authorityEpochId: "epoch-1",
        lastReceiptId: "unknown-1",
        commandStatus: "PENDING",
        stopReceiptId: "stop-intent-1",
        unresolved: false,
        unobserved: false,
        ...patch,
      },
    ],
  })
  return { query, client: { query } as unknown as pg.PoolClient }
}
const reconcile = { id: "reconcile-1", attemptId: "attempt-1", commandType: "RECONCILE" }

describe("authenticated physical cleanup", () => {
  it.each([{ unresolved: true }, { unobserved: true }, { commandStatus: "UNKNOWN" }])(
    "keeps unresolved effects or unobserved commands held (%j)",
    async (patch) => {
      const f = fixture(patch)
      expect(
        await applyAuthenticatedCleanup(f.client, "operation-1", reconcile, "receipt-1", "STOPPED")
      ).toBe(false)
      expect(f.query).toHaveBeenCalledTimes(1)
    }
  )
  it("requires fresh reconciliation to resolve an earlier UNKNOWN", async () => {
    const f = fixture()
    expect(
      await applyAuthenticatedCleanup(
        f.client,
        "operation-1",
        { ...reconcile, commandType: "STOP" },
        "receipt-1",
        "STOPPED"
      )
    ).toBe(false)
    expect(f.query).toHaveBeenCalledTimes(1)
  })
  it("completes actual reconciliation before closing interrupted commands and terminal projection", async () => {
    const f = fixture()
    expect(
      await applyAuthenticatedCleanup(f.client, "operation-1", reconcile, "receipt-1", "STOPPED")
    ).toBe(true)
    const writes = f.query.mock.calls.slice(1)
    expect(writes[0]![0]).toContain("status='ACCEPTED'")
    expect(writes[1]![0]).toContain("status='COMPLETED'")
    expect(writes[2]![0]).toContain("status='REJECTED'")
    expect(writes[3]![1]).toEqual([
      expect.any(String),
      "attempt-1",
      "operation-1",
      4,
      "UNKNOWN",
      "STOPPED",
      "receipt-1",
    ])
    expect(writes[5]![0]).toContain("'REVIEW_REQUIRED'")
    expect(writes.every(([sql]) => !String(sql).includes('UPDATE "ScanCapacityReservation"'))).toBe(
      true
    )
  })
  it("uses the actual STOP acceptance for the active transition and keeps revisions ordered", async () => {
    const f = fixture({ state: "ACTIVE", revision: 5 })
    expect(
      await applyAuthenticatedCleanup(f.client, "operation-1", reconcile, "receipt-1", "STOPPED")
    ).toBe(true)
    const transitions = f.query.mock.calls.filter(([sql]) =>
      String(sql).startsWith('INSERT INTO "ScanPhysicalExecutionTransition"')
    )
    expect(transitions.map(([, values]) => (values as unknown[]).slice(3))).toEqual([
      [6, "ACTIVE", "STOP_REQUESTED", "stop-intent-1"],
      [7, "STOP_REQUESTED", "STOPPED", "receipt-1"],
    ])
  })
  it("does not turn an active observation or mismatched terminal into cleanup", async () => {
    const f = fixture()
    expect(
      await applyAuthenticatedCleanup(f.client, "operation-1", reconcile, "receipt-1", "STARTED")
    ).toBe(false)
    expect(f.query).not.toHaveBeenCalled()
  })
})
