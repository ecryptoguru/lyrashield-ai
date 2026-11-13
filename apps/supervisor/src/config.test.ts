import { describe, expect, it } from "vitest"
import { loadSupervisorConfig } from "./config"

describe("unqualified supervisor entrypoint", () => {
  it("refuses to open even if an operator supplies the open flag", () => {
    expect(() => loadSupervisorConfig({ LYRASHIELD_RUNTIME_ADMISSION: "open" })).toThrow(
      /held until broker and journal qualification/
    )
  })
})
