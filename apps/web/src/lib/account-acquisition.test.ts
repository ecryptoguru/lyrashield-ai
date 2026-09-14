import { beforeEach, describe, expect, it, vi } from "vitest"

const { createMany, findUnique, withAccountRLS } = vi.hoisted(() => ({
  createMany: vi.fn(),
  findUnique: vi.fn(),
  withAccountRLS: vi.fn(),
}))

withAccountRLS.mockImplementation((_accountId: string, cb: (tx: unknown) => unknown) =>
  cb({ accountAcquisition: { createMany, findUnique } })
)

vi.mock("@lyrashield/db", () => ({ withAccountRLS }))

import { claimAccountAcquisition } from "./account-acquisition"

describe("claimAccountAcquisition", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createMany.mockResolvedValue({ count: 1 })
    findUnique.mockResolvedValue({ targetTypeHint: "url" })
  })

  it("does nothing for a null or empty snapshot", async () => {
    expect(await claimAccountAcquisition("acct-1", null)).toBeNull()
    expect(await claimAccountAcquisition("acct-1", {})).toBeNull()
    expect(createMany).not.toHaveBeenCalled()
  })

  it("writes once inside the account RLS context and reads the persisted hint", async () => {
    const result = await claimAccountAcquisition("acct-1", {
      source: "lite_check",
      cta: "review_app",
      utmSource: "x",
      utmCampaign: "launch_wave_a",
      landingRoute: "scan",
      targetTypeHint: "url",
    })

    expect(withAccountRLS).toHaveBeenCalledWith("acct-1", expect.any(Function))
    expect(createMany).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ targetTypeHint: "url" })
  })

  it("returns the persisted first-touch hint, not the later request's", async () => {
    // Second visit arrives with a different hint — the stored row wins.
    findUnique.mockResolvedValue({ targetTypeHint: "api" })
    const result = await claimAccountAcquisition("acct-1", {
      source: "landing_hero",
      targetTypeHint: "url",
    })
    expect(result).toEqual({ targetTypeHint: "api" })
  })
})
