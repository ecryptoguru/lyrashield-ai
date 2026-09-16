import "./test-env"
import { describe, expect, it, vi } from "vitest"
import { manageBooking, operatorAssign, operatorRelease } from "./service"

const booking = {
  id: "booking-1",
  status: "CONFIRMED",
  startsAt: new Date("2026-09-20T10:00:00Z"),
  endsAt: new Date("2026-09-20T10:30:00Z"),
  timezone: "Asia/Kolkata",
  attendeeEmail: "person@example.com",
  attendeeName: "Person",
  meetLink: "https://meet.google.com/example",
  conferenceState: "ready",
  organizerEmail: "ankit@lyrashieldai.com",
  manageTokenExpiresAt: new Date("2026-09-15T00:00:00Z"),
  manageTokenRevokedAt: null,
}

describe("booking management credentials", () => {
  it("rejects an expired management token before returning booking PII", async () => {
    const db = { demoBooking: { findUnique: vi.fn().mockResolvedValue(booking) } }
    await expect(
      manageBooking("expired-token", "get", undefined, db as never)
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("rejects a revoked management token before returning booking PII", async () => {
    const db = {
      demoBooking: {
        findUnique: vi.fn().mockResolvedValue({
          ...booking,
          manageTokenExpiresAt: new Date("2099-09-20T00:00:00Z"),
          manageTokenRevokedAt: new Date("2026-09-15T00:00:00Z"),
        }),
      },
    }
    await expect(
      manageBooking("revoked-token", "get", undefined, db as never)
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
})

describe("operator handoff", () => {
  it("assigns a case and audits the mutation", async () => {
    const db = {
      supportCase: {
        findUnique: vi.fn().mockResolvedValue({ id: "case-1", workspaceId: "ws-1" }),
        update: vi.fn().mockResolvedValue({ id: "case-1", assigneeUserId: "op-1" }),
      },
      myraAuditEvent: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
    }
    await expect(operatorAssign("op-1", "case-1", db as never)).resolves.toEqual({
      assigneeUserId: "op-1",
    })
    expect(db.supportCase.update).toHaveBeenCalledWith({
      where: { id: "case-1" },
      data: { assigneeUserId: "op-1" },
    })
  })

  it("requires and stores a screened handoff summary before release", async () => {
    const update = vi.fn().mockResolvedValue({})
    const db = {
      supportCase: {
        findUnique: vi.fn().mockResolvedValue({
          id: "case-1",
          workspaceId: "ws-1",
          conversationId: null,
        }),
        update,
      },
      myraAuditEvent: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
    }

    await expect(operatorRelease("op-1", "case-1", "short", db as never)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    })
    await operatorRelease(
      "op-1",
      "case-1",
      "Reviewed outcome with ghp_abcdefghijklmnopqrstuvwxyz123456.",
      db as never
    )
    expect(update).toHaveBeenCalledWith({
      where: { id: "case-1" },
      data: expect.objectContaining({
        takenOverAt: null,
        handoffSummary: expect.not.stringContaining("ghp_"),
        handoffReviewedBy: "op-1",
      }),
    })
  })
})
