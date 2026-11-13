import { describe, expect, it } from "vitest"
import { readCurrentRetainedCommand } from "./retained-command-reader"

describe("retained command source", () => {
  it("rejects a caller-supplied reader before accepting command history", async () => {
    await expect(
      Reflect.apply(readCurrentRetainedCommand, undefined, [
        {
          reader: { withRead: async () => ({}) },
          continuation: {},
          streamId: "stream-test",
          command: {},
        },
      ])
    ).rejects.toThrow("SUPERVISOR_COMMAND_HISTORY_UNAVAILABLE")
  })
})
