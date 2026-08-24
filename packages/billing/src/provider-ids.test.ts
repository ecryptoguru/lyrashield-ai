import { describe, expect, it } from "vitest"
import { resolveProviderId, resolveProviderKey } from "./provider-ids"

describe("resolveProviderId", () => {
  it("returns only a configured non-empty string ID", () => {
    const raw = JSON.stringify({ starter_monthly: "prod_real", empty: " ", wrong: 1 })

    expect(resolveProviderId(raw, "starter_monthly")).toBe("prod_real")
    expect(resolveProviderId(raw, "empty")).toBeNull()
    expect(resolveProviderId(raw, "wrong")).toBeNull()
    expect(resolveProviderId(raw, "missing")).toBeNull()
    expect(resolveProviderId("not-json", "starter_monthly")).toBeNull()
  })

  it("maps a provider-owned ID back to its catalog key", () => {
    const raw = JSON.stringify({ starter_monthly: "prod_starter", pack_100: "prod_pack" })

    expect(resolveProviderKey(raw, "prod_pack")).toBe("pack_100")
    expect(resolveProviderKey(raw, "unknown")).toBeNull()
    expect(resolveProviderKey("not-json", "prod_pack")).toBeNull()
  })

  it("keeps the first configured ID current while resolving immutable legacy IDs", () => {
    const raw = JSON.stringify({ starter_monthly: ["prod_current", "prod_legacy"] })

    expect(resolveProviderId(raw, "starter_monthly")).toBe("prod_current")
    expect(resolveProviderKey(raw, "prod_current")).toBe("starter_monthly")
    expect(resolveProviderKey(raw, "prod_legacy")).toBe("starter_monthly")
  })

  it("fails closed when a legacy-ID array is empty or contains malformed entries", () => {
    expect(resolveProviderId(JSON.stringify({ starter_monthly: [] }), "starter_monthly")).toBeNull()
    expect(
      resolveProviderId(JSON.stringify({ starter_monthly: ["prod_current", 7] }), "starter_monthly")
    ).toBeNull()
    expect(
      resolveProviderKey(JSON.stringify({ starter_monthly: ["prod_current", 7] }), "prod_current")
    ).toBeNull()
  })
})
