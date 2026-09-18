/**
 * Write-gate coverage for confirmProposal (v19 fix 1.3): the validated
 * MYRA_WRITES_ENABLED / MYRA_ALLOWED_EMAILS gate is the only barrier between
 * a chat proposal and a real booking/case write. Everything below the gate —
 * the proposal row, the executor, the audit write — is mocked so each case
 * isolates exactly the gate decision.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ResolvedMyraRequest } from "./context"

const env = vi.hoisted(() => ({
  MYRA_WRITES_ENABLED: "0",
  MYRA_ALLOWED_EMAILS: "",
}))

const proposalRecord = vi.hoisted(() => ({ value: null as unknown }))

vi.mock("@lyrashield/config", () => ({
  env,
  isMyraAllowedEmail: (email: string, allowlist: string) =>
    allowlist.split(",").includes(email.trim().toLowerCase()),
}))
vi.mock("@lyrashield/db", () => ({ prisma: {} }))
vi.mock("@lyrashield/integrations", () => ({ sendNotification: vi.fn() }))
vi.mock("./db", () => ({
  withOwnerScope: (_principal: unknown, run: (tx: unknown) => unknown) =>
    run({ myraOperation: { findUnique: vi.fn(async () => proposalRecord.value) } }),
  ownerWhere: () => ({}),
  withTrustedScope: (_principal: unknown, run: (tx: unknown) => unknown) => run({}),
  MYRA_TRUSTED_MANAGE_TOKEN: "trusted-manage-token",
}))
vi.mock("./operations", () => ({
  confirm: vi.fn(async () => ({ status: "COMPLETED", result: {}, privateResult: undefined })),
  cancel: vi.fn(async () => ({})),
  invalidateForConversation: vi.fn(async () => {}),
}))
vi.mock("./audit", () => ({ auditEvent: vi.fn(async () => {}) }))
vi.mock("./loop", () => ({ newTraceId: () => "trace-test", runTaskLoop: vi.fn() }))
vi.mock("./tools/demo", () => ({
  computeDemoSlots: vi.fn(),
  executeBookDemo: vi.fn(),
  executeManageDemo: vi.fn(),
  hashManageToken: vi.fn(() => "token-hash"),
  isManageTokenActive: vi.fn(() => true),
  reconcileDemoBooking: vi.fn(),
}))
vi.mock("./tools/cases", () => ({
  executeSubmitSupportCase: vi.fn(),
  runReadOwnCase: vi.fn(),
  runSendCaseReply: vi.fn(),
}))
vi.mock("./tools/registry", () => ({ runTool: vi.fn() }))
vi.mock("../sanitize", () => ({ screenSecrets: (value: unknown) => value }))

const { confirmProposal } = await import("./service")

const anonymousCtx: ResolvedMyraRequest = {
  principal: { kind: "anonymous", publicSessionId: "ps-1" },
  workspaceId: null,
  role: null,
}

function userCtx(over: Record<string, unknown> = {}): ResolvedMyraRequest {
  return {
    principal: {
      kind: "user",
      accountId: "acct-1",
      sessionId: "sess-1",
      email: "ankit@lyrashieldai.com",
      emailVerified: true,
      workspaceId: null,
      role: null,
      ...over,
    } as ResolvedMyraRequest["principal"],
    workspaceId: null,
    role: null,
  }
}

describe("Myra write gate on confirmProposal", () => {
  beforeEach(() => {
    env.MYRA_WRITES_ENABLED = "0"
    env.MYRA_ALLOWED_EMAILS = ""
    proposalRecord.value = {
      id: "p1",
      conversationId: "c1",
      workspaceId: null,
      operationName: "book_demo",
    }
  })

  it("denies every principal while writes are off", async () => {
    await expect(confirmProposal(userCtx(), "p1")).rejects.toMatchObject({
      code: "WRITES_DISABLED",
    })
    await expect(confirmProposal(anonymousCtx, "p1")).rejects.toMatchObject({
      code: "WRITES_DISABLED",
    })
  })

  it("denies an anonymous book_demo confirm while an allowlist is set", async () => {
    env.MYRA_WRITES_ENABLED = "1"
    env.MYRA_ALLOWED_EMAILS = "ankit@lyrashieldai.com"
    await expect(confirmProposal(anonymousCtx, "p1")).rejects.toMatchObject({
      code: "WRITES_DISABLED",
    })
  })

  it("denies an allowlisted user whose email is not verified", async () => {
    env.MYRA_WRITES_ENABLED = "1"
    env.MYRA_ALLOWED_EMAILS = "ankit@lyrashieldai.com"
    await expect(
      confirmProposal(userCtx({ emailVerified: false }), "p1")
    ).rejects.toMatchObject({ code: "WRITES_DISABLED" })
  })

  it("admits the verified allowlisted user", async () => {
    env.MYRA_WRITES_ENABLED = "1"
    env.MYRA_ALLOWED_EMAILS = "ankit@lyrashieldai.com"
    await expect(confirmProposal(userCtx(), "p1")).resolves.toMatchObject({
      status: "COMPLETED",
    })
  })

  it("admits users when the allowlist is empty outside production", async () => {
    env.MYRA_WRITES_ENABLED = "1"
    env.MYRA_ALLOWED_EMAILS = ""
    await expect(
      confirmProposal(userCtx({ email: "dev@example.com" }), "p1")
    ).resolves.toMatchObject({ status: "COMPLETED" })
  })
})
