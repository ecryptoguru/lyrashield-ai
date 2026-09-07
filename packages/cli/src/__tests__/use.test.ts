import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ saveCredentials: vi.fn(), loadCredentials: vi.fn() }))

vi.mock("../credentials.js", () => mocks)

import { handleUse } from "../commands/use.js"

describe("use", () => {
  beforeEach(() => vi.clearAllMocks())

  it("does not store a global flag as a workspace ID", async () => {
    const output = { error: vi.fn(), log: vi.fn() }

    expect(await handleUse(["--json"], output as never)).toBe(2)
    expect(mocks.saveCredentials).not.toHaveBeenCalled()
  })
})
