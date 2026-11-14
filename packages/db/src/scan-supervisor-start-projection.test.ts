import type pg from "pg"
import { describe, expect, it, vi } from "vitest"
import { applyAuthenticatedStart } from "./scan-supervisor-start-projection"

const command = { id: "start-one", attemptId: "attempt-one", commandType: "START_UNMETERED" }
function fixture(state = "ACTIVE", status = "COMPLETED", present = true) {
  const query = vi.fn().mockResolvedValue({ rows: [] })
  query.mockResolvedValueOnce({
    rows: [{ createReceiptId: "create-one", startedReceiptId: "started-one" }],
  })
  query.mockResolvedValueOnce({ rows: [{ state, status, revision: 7 }] })
  if (status === "COMPLETED") query.mockResolvedValueOnce({ rows: [{ present }] })
  return { query, client: { query } as unknown as pg.PoolClient }
}

describe("authenticated START replay", () => {
  it.each(["ACTIVE", "STOP_REQUESTED", "CLEANUP_PENDING", "STOPPED", "UNKNOWN"])(
    "preserves %s after an already completed START without any projection writes",
    async (state) => {
      const f = fixture(state)
      expect(
        await applyAuthenticatedStart(f.client, "operation-one", command, "terminal-one")
      ).toBe(true)
      expect(f.query).toHaveBeenCalledTimes(3)
      expect(f.query.mock.calls.every(([sql]) => String(sql).startsWith("SELECT"))).toBe(true)
      expect(f.query.mock.calls[2]![1]).toEqual(["operation-one", "attempt-one", 7, "started-one"])
    }
  )

  it("rejects completed history without its scoped earlier ACTIVE transition", async () => {
    const f = fixture("STOPPED", "COMPLETED", false)
    await expect(
      applyAuthenticatedStart(f.client, "operation-one", command, "terminal-one")
    ).rejects.toThrow()
    expect(f.query.mock.calls.every(([sql]) => String(sql).startsWith("SELECT"))).toBe(true)
  })

  it.each(["STOP_REQUESTED", "CLEANUP_PENDING", "STOPPED", "UNKNOWN", "NEVER_DISPATCHED"])(
    "rejects a fresh START in %s",
    async (state) => {
      const f = fixture(state, "ACCEPTED")
      await expect(
        applyAuthenticatedStart(f.client, "operation-one", command, "terminal-one")
      ).rejects.toThrow()
      expect(f.query).toHaveBeenCalledTimes(2)
    }
  )

  it.each(["RESERVED", "PREPARING", "DISPATCH_PENDING", "NEVER_DISPATCHED"])(
    "does not recreate completed START projections from unsupported %s history",
    async (state) => {
      const f = fixture(state)
      await expect(
        applyAuthenticatedStart(f.client, "operation-one", command, "terminal-one")
      ).rejects.toThrow()
      expect(f.query).toHaveBeenCalledTimes(2)
    }
  )

  it("still requires exact retained native proofs before replay", async () => {
    const f = fixture("STOPPED")
    f.query.mockReset().mockResolvedValue({ rows: [] })
    expect(await applyAuthenticatedStart(f.client, "operation-one", command, "terminal-one")).toBe(
      false
    )
    expect(f.query).toHaveBeenCalledTimes(1)
  })

  it("keeps the fresh START transition sequence and completion behavior", async () => {
    const f = fixture("PREPARING", "ACCEPTED")
    expect(await applyAuthenticatedStart(f.client, "operation-one", command, "terminal-one")).toBe(
      true
    )
    const transitions = f.query.mock.calls.filter(([sql]) =>
      String(sql).startsWith('INSERT INTO "ScanPhysicalExecutionTransition"')
    )
    expect(transitions.map(([, values]) => (values as unknown[]).slice(3))).toEqual([
      [8, "create-one"],
      [9, "started-one"],
    ])
    expect(f.query.mock.calls.some(([sql]) => String(sql).includes("status='COMPLETED'"))).toBe(
      true
    )
  })
})
