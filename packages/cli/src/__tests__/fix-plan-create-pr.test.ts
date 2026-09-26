import { beforeEach, expect, it, vi } from "vitest"
import { handleFixPlan } from "../commands/fix-plan.js"
import { createClient } from "../client.js"
import { requestFixPr } from "@lyrashield/sdk"
import type { Output } from "../output.js"

vi.mock("../client.js", () => ({ createClient: vi.fn().mockResolvedValue({}) }))
vi.mock("../credentials.js", () => ({
  getEffectiveCredentials: vi.fn().mockResolvedValue({ workspaceId: "ws-1" }),
  requireWorkspace: vi.fn((value: { workspaceId: string }) => value.workspaceId),
}))
vi.mock("@lyrashield/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lyrashield/sdk")>()),
  requestFixPr: vi.fn().mockResolvedValue({ status: "pending_approval", approvalId: "approval-1" }),
}))

const output = { result: vi.fn(), error: vi.fn() } as unknown as Output
beforeEach(() => vi.clearAllMocks())

it("requests the stored proposal without supplying a patch or approving it", async () => {
  expect(
    await handleFixPlan(["create-pr", "proposal-1", "--idempotency-key", "request-1"], output)
  ).toBe(0)
  expect(requestFixPr).toHaveBeenCalledWith(await createClient(), "proposal-1", {
    workspaceId: "ws-1",
    idempotencyKey: "request-1",
  })
  expect(output.result).toHaveBeenCalledWith({
    status: "pending_approval",
    approvalId: "approval-1",
  })
})
