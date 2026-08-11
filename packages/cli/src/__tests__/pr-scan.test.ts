import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Output } from "../output.js"

const mocks = vi.hoisted(() => ({ handleScan: vi.fn() }))
vi.mock("../commands/scan.js", () => ({ handleScan: mocks.handleScan }))

import { handlePrScan } from "../commands/pr-scan.js"

const output = {} as Output

describe("handlePrScan", () => {
  beforeEach(() => {
    mocks.handleScan.mockReset()
    mocks.handleScan.mockResolvedValue(0)
  })

  it.each([
    ["equals-form mode", ["--mode=DEEP"], ["--goal", "CHECK_PR", "--mode=DEEP"]],
    ["short-form mode", ["-m", "DEEP"], ["--goal", "CHECK_PR", "-m", "DEEP"]],
    ["equals-form goal", ["--goal=TEST_APP"], ["--mode", "QUICK", "--goal=TEST_APP"]],
    ["short-form goal", ["-g", "TEST_APP"], ["--mode", "QUICK", "-g", "TEST_APP"]],
  ])("does not add duplicate defaults for %s", async (_label, args, expectedArgs) => {
    await handlePrScan(args, output)

    expect(mocks.handleScan).toHaveBeenCalledWith(expectedArgs, output)
  })
})
