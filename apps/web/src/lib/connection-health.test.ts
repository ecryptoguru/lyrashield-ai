import { describe, expect, it } from "vitest"
import { connectionHealth } from "./connection-health"

describe("effective connection health", () => {
  for (const status of ["PAUSED", "REVOKED", "EXPIRED"]) {
    it(`never marks ${status} credentials usable`, () => {
      expect(
        connectionHealth({
          status,
          scopes: ["lyrashield.read", "lyrashield.write"],
          expiresAt: null,
        }).usability
      ).toBe("Access unavailable")
    })
  }
  it("requires reconnect for a paused connection after expiry", () => {
    expect(
      connectionHealth(
        { status: "PAUSED", scopes: ["lyrashield.read"], expiresAt: new Date(1000) },
        1000
      )
    ).toMatchObject({ status: "EXPIRED", reconnect: true })
  })
  it("expires at the boundary and supports read-only and empty scopes", () => {
    const base = { status: "ACTIVE", scopes: ["lyrashield.read"], expiresAt: new Date(1000) }
    expect(connectionHealth(base, 999).usability).toBe("Read-only access")
    expect(connectionHealth(base, 1000).status).toBe("EXPIRED")
    expect(connectionHealth({ ...base, expiresAt: null, scopes: [] }).usability).toBe(
      "Access unavailable"
    )
  })
})
