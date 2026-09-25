import "./test-env"
import { createHash, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createBoundedPgAdapter, prisma } from "@lyrashield/db"
import { PrismaClient } from "@lyrashield/db/src/generated/prisma"
import { cancel, confirm, createProposal } from "./operations"

const runtimeUrl = process.env.RLS_RUNTIME_DATABASE_URL
const systemUrl = process.env.DATABASE_SYSTEM_URL
const restrictedRun = Boolean(runtimeUrl && systemUrl && process.env.DATABASE_URL === runtimeUrl)
if (!restrictedRun) {
  console.warn(
    "[operations.runtime] SKIPPED: run with DATABASE_URL=RLS_RUNTIME_DATABASE_URL and " +
      "DATABASE_SYSTEM_URL set to a disposable database owner connection."
  )
}

const system = restrictedRun
  ? new PrismaClient({ adapter: createBoundedPgAdapter(systemUrl!) })
  : null
const suffix = randomUUID().replace(/-/g, "").slice(0, 12)
const user = { kind: "user" as const, accountId: `myra-hash-${suffix}`, sessionId: `s-${suffix}` }
const anonymous = { kind: "anonymous" as const, publicSessionId: `myra-public-${suffix}` }
const operationIds: string[] = []

describe.skipIf(!restrictedRun)("proposal integrity after PostgreSQL JSONB persistence", () => {
  beforeAll(async () => {
    const [role] = await prisma.$queryRaw<
      Array<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>
    >`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false })
    // The system connection is only for privileged tampering/cleanup. The
    // operation calls below use the restricted DATABASE_URL under owner RLS.
    expect(process.env.DATABASE_URL).toBe(runtimeUrl)
  })

  afterAll(async () => {
    if (system) {
      await system.myraOperation.deleteMany({ where: { id: { in: operationIds } } })
      await system.$disconnect()
    }
  })

  it.each([
    ["account", user],
    ["anonymous", anonymous],
  ] as const)("confirms unchanged nested %s proposal exactly once", async (_scope, principal) => {
    const payload = {
      slotStart: "2026-10-01T10:00:00Z",
      timezone: "Asia/Kolkata",
      attendee: { name: "Review", email: "review@example.test" },
    }
    const proposal = await createProposal({ principal }, "book_demo", payload)
    operationIds.push(proposal.id)
    const loaded = await system!.myraOperation.findUniqueOrThrow({ where: { id: proposal.id } })
    expect(loaded.payload).toEqual(payload)
    const executor = vi.fn(async () => ({ result: { accepted: true } }))
    await expect(confirm({ principal }, proposal.id, executor)).resolves.toMatchObject({
      status: "COMPLETED",
    })
    expect(executor).toHaveBeenCalledTimes(1)
    await expect(confirm({ principal }, proposal.id, executor)).rejects.toMatchObject({
      code: "PROPOSAL_STATE_INVALID",
    })
    expect(executor).toHaveBeenCalledTimes(1)
  })

  it("rejects a foreign owner before execution", async () => {
    const proposal = await createProposal({ principal: user }, "book_demo", { slotStart: "x" })
    operationIds.push(proposal.id)
    const executor = vi.fn(async () => ({ result: { accepted: true } }))
    await expect(
      confirm(
        { principal: { ...user, accountId: `${user.accountId}-other` } },
        proposal.id,
        executor
      )
    ).rejects.toMatchObject({ code: expect.stringMatching(/NOT_FOUND|OWNERSHIP_MISMATCH/) })
    expect(executor).not.toHaveBeenCalled()
  })

  it("rejects tampered persisted values before execution", async () => {
    const proposal = await createProposal({ principal: user }, "book_demo", {
      attendee: { name: "Original" },
    })
    operationIds.push(proposal.id)
    await system!.myraOperation.update({
      where: { id: proposal.id },
      data: { payload: { attendee: { name: "Changed" } } },
    })
    const executor = vi.fn(async () => ({ result: { accepted: true } }))
    await expect(confirm({ principal: user }, proposal.id, executor)).rejects.toMatchObject({
      code: "PROPOSAL_PAYLOAD_CHANGED",
    })
    expect(executor).not.toHaveBeenCalled()
  })

  it("rejects an expired proposal before execution", async () => {
    const proposal = await createProposal({ principal: user }, "book_demo", { slotStart: "x" })
    operationIds.push(proposal.id)
    await system!.myraOperation.update({
      where: { id: proposal.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    })
    const executor = vi.fn(async () => ({ result: { accepted: true } }))
    await expect(confirm({ principal: user }, proposal.id, executor)).rejects.toMatchObject({
      code: "PROPOSAL_EXPIRED",
    })
    expect(executor).not.toHaveBeenCalled()
  })

  it("requires a fresh preview for a legacy insertion-order hash", async () => {
    const payload = { slotStart: "x", attendee: { name: "Legacy" } }
    const proposal = await createProposal({ principal: user }, "book_demo", payload)
    operationIds.push(proposal.id)
    await system!.myraOperation.update({
      where: { id: proposal.id },
      data: {
        inputHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      },
    })
    const executor = vi.fn(async () => ({ result: { accepted: true } }))
    await expect(confirm({ principal: user }, proposal.id, executor)).rejects.toMatchObject({
      code: "PROPOSAL_PAYLOAD_CHANGED",
      message: expect.stringMatching(/prepare.*again/i),
    })
    expect(executor).not.toHaveBeenCalled()
  })

  it("does not report cancellation after execution has started", async () => {
    const proposal = await createProposal({ principal: user }, "book_demo", { slotStart: "x" })
    operationIds.push(proposal.id)
    let markStarted!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => (markStarted = resolve))
    const held = new Promise<void>((resolve) => (release = resolve))
    const executor = vi.fn(async () => {
      markStarted()
      await held
      return { result: { accepted: true } }
    })
    const confirming = confirm({ principal: user }, proposal.id, executor)
    await started
    expect(await cancel({ principal: user }, proposal.id)).toEqual({ status: "EXECUTING" })
    release()
    await expect(confirming).resolves.toMatchObject({ status: "COMPLETED" })
    expect(await cancel({ principal: user }, proposal.id)).toEqual({ status: "COMPLETED" })
    expect(executor).toHaveBeenCalledTimes(1)
  })

  it("lets cancellation win before execution claims the proposal", async () => {
    const proposal = await createProposal({ principal: anonymous }, "book_demo", {
      slotStart: "x",
    })
    operationIds.push(proposal.id)
    expect(await cancel({ principal: anonymous }, proposal.id)).toEqual({ status: "CANCELED" })
    expect(await cancel({ principal: anonymous }, proposal.id)).toEqual({ status: "CANCELED" })
    const executor = vi.fn(async () => ({ result: { accepted: true } }))
    await expect(confirm({ principal: anonymous }, proposal.id, executor)).rejects.toMatchObject({
      code: "PROPOSAL_STATE_INVALID",
    })
    expect(executor).not.toHaveBeenCalled()
  })

  it("does not reveal or cancel a foreign owner's proposal", async () => {
    const proposal = await createProposal({ principal: user }, "book_demo", { slotStart: "x" })
    operationIds.push(proposal.id)
    await expect(
      cancel({ principal: { ...user, accountId: `${user.accountId}-other` } }, proposal.id)
    ).rejects.toMatchObject({ code: expect.stringMatching(/NOT_FOUND|OWNERSHIP_MISMATCH/) })
    expect(
      (await system!.myraOperation.findUniqueOrThrow({ where: { id: proposal.id } })).status
    ).toBe("AWAITING_CONFIRMATION")
  })
})
