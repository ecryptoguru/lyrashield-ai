import { beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ event: vi.fn() }))
vi.mock("@lyrashield/db", () => ({ addScanEvent: mocks.event }))
vi.mock("@lyrashield/billing", () => ({ hasUnsettledScanIntent: vi.fn() }))
import { enterEngineBillablePhase } from "./lifecycle-utils"
import { ScanBillableClaimError } from "@lyrashield/db/src/scan-billable-claim"
beforeEach(() => {
  mocks.event.mockReset()
})
it("does not cross the billable boundary if its durable event cannot be recorded", async () => {
  const mark = vi.fn()
  mocks.event.mockRejectedValue(new Error("database unavailable"))
  await expect(enterEngineBillablePhase("scan-1", mark)).rejects.toMatchObject({
    name: "ScanBillableClaimError",
    cause: expect.objectContaining({ message: "database unavailable" }),
  })
  expect(mark).not.toHaveBeenCalled()
})
it("preserves a confirmed rollback for a guarded pre-billing retry", async () => {
  const error = Object.assign(new Error("transaction rolled back"), { code: "P2034" })
  const mark = vi.fn()
  mocks.event.mockRejectedValue(error)
  await expect(enterEngineBillablePhase("scan-1", mark)).rejects.toBe(error)
  expect(error).not.toBeInstanceOf(ScanBillableClaimError)
  expect(mark).not.toHaveBeenCalled()
})
it("marks the billable phase only after the durable event completes", async () => {
  const order: string[] = []
  mocks.event.mockImplementation(async () => {
    await Promise.resolve()
    order.push("recorded")
  })
  await enterEngineBillablePhase("scan-1", () => order.push("marked"))
  expect(order).toEqual(["recorded", "marked"])
})
