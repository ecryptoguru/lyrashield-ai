import { describe, expect, it } from "vitest"
import { resolveProviderId } from "./provider-ids"

describe("resolveProviderId", () => {
  it("returns only a configured non-empty string ID", () => {
    const raw = JSON.stringify({ starter_monthly: "prod_real", empty: " ", wrong: 1 })

    expect(resolveProviderId(raw, "starter_monthly")).toBe("prod_real")
    expect(resolveProviderId(raw, "empty")).toBeNull()
    expect(resolveProviderId(raw, "wrong")).toBeNull()
    expect(resolveProviderId(raw, "missing")).toBeNull()
    expect(resolveProviderId("not-json", "starter_monthly")).toBeNull()
  })
})
