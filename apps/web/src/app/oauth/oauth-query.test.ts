import { describe, expect, it } from "vitest"
import { serializeOAuthQuery } from "./oauth-query"

describe("serializeOAuthQuery", () => {
  it("preserves the signed OAuth request while omitting absent values", () => {
    expect(
      serializeOAuthQuery({ client_id: "client", scope: ["lyrashield.read"], state: "state", absent: undefined })
    ).toBe("client_id=client&scope=lyrashield.read&state=state")
  })
})
