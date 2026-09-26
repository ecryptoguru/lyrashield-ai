import { beforeEach, describe, expect, it, vi } from "vitest"
import { handleCancel } from "../commands/cancel.js"
import type { Output } from "../output.js"
import { createClient } from "../client.js"

vi.mock("../client.js", () => ({ createClient: vi.fn() }))
vi.mock("../credentials.js", () => ({
  getEffectiveCredentials: vi.fn().mockResolvedValue({ workspaceId: "ws-1" }),
  requireWorkspace: vi.fn((value: { workspaceId: string }) => value.workspaceId),
}))

const output = {
  result: vi.fn(),
  error: vi.fn(),
} as unknown as Output

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(createClient).mockResolvedValue({
    request: vi.fn().mockResolvedValue({ id: "scan-1", status: "CANCELLED" }),
  } as never)
})

describe("cancel command", () => {
  it("uses the authorized POST transition and forwards an explicit request key", async () => {
    expect(await handleCancel(["scan-1", "--idempotency-key", "request-1"], output)).toBe(0)
    const client = await createClient()
    expect(client.request).toHaveBeenCalledWith("POST", "/scans/scan-1", {
      body: { workspaceId: "ws-1" },
      headers: { "Idempotency-Key": "request-1" },
    })
    expect(output.result).toHaveBeenCalledWith({ id: "scan-1", status: "CANCELLED" })
  })

  it("rejects missing scan ID before creating a client", async () => {
    expect(await handleCancel([], output)).toBe(2)
    expect(createClient).not.toHaveBeenCalled()
  })
})
