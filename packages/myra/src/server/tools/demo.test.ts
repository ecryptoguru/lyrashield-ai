import "../test-env"
import { describe, expect, it, vi } from "vitest"
import { executeManageDemo, hashManageToken, runManageOwnDemo } from "./demo"
import { MyraServiceError } from "../errors"

const OWN_TOKEN = "own-manage-token-0123456789abcdef"
const FOREIGN_TOKEN = "foreign-manage-token-0123456789ab"
const FOREIGN_BOOKING_ID = "booking-foreign"

const ownBooking = {
  id: "booking-own",
  status: "CONFIRMED",
  manageTokenHash: hashManageToken(OWN_TOKEN),
  manageTokenExpiresAt: new Date(Date.now() + 86_400_000),
  manageTokenRevokedAt: null,
  startsAt: new Date(Date.now() + 172_800_000),
}

const foreignBooking = {
  id: FOREIGN_BOOKING_ID,
  status: "CONFIRMED",
  manageTokenHash: hashManageToken(FOREIGN_TOKEN),
  manageTokenExpiresAt: new Date(Date.now() + 86_400_000),
  manageTokenRevokedAt: null,
  startsAt: new Date(Date.now() + 172_800_000),
}

/** Fake db whose demoBooking table holds both rows; the spy records every read. */
function fakeDb() {
  const findUnique = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    for (const row of [ownBooking, foreignBooking]) {
      if (where.id === row.id) return row
      if (where.manageTokenHash === row.manageTokenHash) return row
    }
    return null
  })
  return { findUnique, db: { demoBooking: { findUnique } } }
}

async function expectForbidden(promise: Promise<unknown>) {
  const caught = await promise.then(
    () => null,
    (e) => e
  )
  expect(caught).toBeInstanceOf(MyraServiceError)
  expect((caught as MyraServiceError).code).toBe("FORBIDDEN")
}

function expectNoForeignRead(findUnique: ReturnType<typeof vi.fn>) {
  for (const call of findUnique.mock.calls) {
    expect(call[0].where).not.toHaveProperty("id", FOREIGN_BOOKING_ID)
  }
}

describe("manage_own_demo booking resolution", () => {
  it("runManageOwnDemo denies a foreign bookingId without reading the foreign row", async () => {
    const { findUnique, db } = fakeDb()

    await expectForbidden(
      runManageOwnDemo(
        {
          principal: { kind: "user", accountId: "acct-1", sessionId: "session-1" },
          surface: "DASHBOARD",
          workspaceId: null,
          role: null,
          conversationId: null,
          routeContext: null,
          db: db as never,
        },
        { bookingId: FOREIGN_BOOKING_ID, manageToken: OWN_TOKEN, action: "cancel" }
      )
    )

    // The bookingId must never be used as a lookup key — only the token hash.
    expect(findUnique).toHaveBeenCalledWith({
      where: { manageTokenHash: hashManageToken(OWN_TOKEN) },
    })
    expectNoForeignRead(findUnique)
  })

  it("executeManageDemo denies a foreign bookingId without reading the foreign row", async () => {
    const { findUnique, db } = fakeDb()

    await expectForbidden(
      executeManageDemo(
        { bookingId: FOREIGN_BOOKING_ID, manageToken: OWN_TOKEN, action: "cancel" },
        {
          principal: { kind: "user", accountId: "acct-1", sessionId: "session-1" },
          db: db as never,
        }
      )
    )

    expect(findUnique).toHaveBeenCalledWith({
      where: { manageTokenHash: hashManageToken(OWN_TOKEN) },
    })
    expectNoForeignRead(findUnique)
  })
})
