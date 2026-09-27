import { afterEach, describe, expect, it, vi } from "vitest"
import { writeClipboard } from "./scorecard-share-composer"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("scorecard clipboard fallback", () => {
  it("uses the DOM fallback when browser clipboard access is blocked", async () => {
    const textarea = { value: "", style: {}, select: vi.fn(), remove: vi.fn() }
    const documentMock = {
      createElement: vi.fn(() => textarea),
      body: { append: vi.fn() },
      execCommand: vi.fn(() => true),
    }
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("permission denied")) },
    })
    vi.stubGlobal("document", documentMock)
    vi.stubGlobal("window", { setTimeout: vi.fn() })

    await expect(writeClipboard("public review link")).resolves.toBeUndefined()
    expect(documentMock.body.append).toHaveBeenCalledWith(textarea)
    expect(textarea.value).toBe("public review link")
    expect(documentMock.execCommand).toHaveBeenCalledWith("copy")
    expect(textarea.remove).toHaveBeenCalledOnce()
  })

  it("reports failure when both clipboard paths are blocked", async () => {
    const textarea = { value: "", style: {}, select: vi.fn(), remove: vi.fn() }
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("permission denied")) },
    })
    vi.stubGlobal("document", {
      createElement: vi.fn(() => textarea),
      body: { append: vi.fn() },
      execCommand: vi.fn(() => false),
    })
    vi.stubGlobal("window", { setTimeout: vi.fn() })

    await expect(writeClipboard("private details stay local")).rejects.toThrow(
      "Clipboard unavailable"
    )
  })
})
