import { describe, expect, it, vi } from "vitest"
import {
  canonicalJson,
  type AuthorityAction,
  type AuthoritySqlConnection,
} from "@lyrashield/runtime-control"
import { createScanExecutionInvocationGuardWriter } from "./scan-execution-invocation-guard"
const binding: AuthorityAction = {
  phase: "PREPARE",
  operationId: "operation-original",
  attemptId: "attempt-original",
  scanId: "scan-original",
  workspaceId: "workspace-original",
  authorityEpochId: "epoch-original",
  authorityRevision: 1,
  authorityChecksum: "a".repeat(64),
  actionChecksum: "b".repeat(64),
  commandId: "command-original",
}
function connection(rows: Record<string, unknown>[][]) {
  const query = vi
    .fn<AuthoritySqlConnection["query"]>()
    .mockImplementation(async () => ({ rows: rows.shift() ?? [] }))
  return { query, release: vi.fn() }
}
describe("durable original invocation guards", () => {
  it("revalidates before insertion, preserves exact identity and never commits the caller transaction", async () => {
    const verify = vi.fn().mockResolvedValue({ deadlineAt: new Date() })
    const c = connection([[], []])
    const result = await createScanExecutionInvocationGuardWriter(verify).begin(c, binding)
    expect(verify).toHaveBeenCalledWith(c, binding)
    expect(c.query.mock.calls[1][1]).toContain(canonicalJson(binding))
    expect(result.guardId).toBeTruthy()
    expect(c.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false)
  })
  it("never replays a retained guard after a lost acknowledgement", async () => {
    const c = connection([[{ id: "original-guard" }]])
    await expect(
      createScanExecutionInvocationGuardWriter(vi.fn().mockResolvedValue({})).begin(c, binding)
    ).rejects.toThrow()
    expect(c.query).toHaveBeenCalledTimes(1)
  })
  it("checks trusted context plus exact confirmed guard after commit", async () => {
    const c = connection([
      [
        {
          workspaceId: binding.workspaceId,
          accountId: "account-original",
          userId: "user-original",
        },
      ],
      [],
      [{ bindingInputJson: canonicalJson(binding) }],
    ])
    await createScanExecutionInvocationGuardWriter(vi.fn()).verifyCommitted(
      c,
      binding,
      "original-guard"
    )
    expect(c.query.mock.calls.at(-1)?.[0]).toContain("app.scan_preparation_gate_held()")
  })
  it("rejects missing, resolved, unheld or changed committed guard", async () => {
    for (const result of [[], [{ bindingInputJson: "{}" }]]) {
      const c = connection([
        [
          {
            workspaceId: binding.workspaceId,
            accountId: "account-original",
            userId: "user-original",
          },
        ],
        [],
        result,
      ])
      await expect(
        createScanExecutionInvocationGuardWriter(vi.fn()).verifyCommitted(
          c,
          binding,
          "original-guard"
        )
      ).rejects.toThrow()
    }
  })
})
