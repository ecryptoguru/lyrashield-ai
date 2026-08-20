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
})
