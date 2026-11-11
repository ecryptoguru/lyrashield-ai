import { describe, expect, it } from "vitest"
import { loadProviderGatewayConfig } from "./config"

describe("unqualified gateway entrypoint", () => {
  it("refuses to open even if an operator supplies the open flag", () => {
    expect(() => loadProviderGatewayConfig({ LYRASHIELD_RUNTIME_ADMISSION: "open" })).toThrow(
      /held until broker and journal qualification/
    )
  })
})
