import { afterEach, describe, expect, it, vi } from "vitest"
import { bufferMotion } from "./buffer-motion"

afterEach(() => vi.unstubAllGlobals())
describe("bounded motion download", () => {
  it("does not expose a partial film before the response body finishes", async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller
      },
    })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)))
    let complete = false
    const result = bufferMotion("/film.mp4", new AbortController().signal, 16, vi.fn()).then(
      (blob) => {
        complete = true
        return blob
      }
    )
    stream.enqueue(new Uint8Array([1]))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(complete).toBe(false)
    stream.enqueue(new Uint8Array([2]))
    stream.close()
    expect(new Uint8Array(await (await result).arrayBuffer())).toEqual(new Uint8Array([1, 2]))
  })
  it("preserves the complete bytes before returning a playable blob", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255])
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(bytes, { headers: { "content-length": "4" } }))
    )
    const progress = vi.fn()
    const blob = await bufferMotion("/film.mp4", new AbortController().signal, 4, progress)
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes)
    expect(blob.type).toBe("video/mp4")
    expect(progress).toHaveBeenCalledWith(99)
  })
  it.each([
    new Response(new Uint8Array([1]), { headers: { "content-length": "8" } }),
    new Response(new Uint8Array([1, 2, 3])),
  ])("rejects over-budget data with or without a declared size", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response))
    await expect(
      bufferMotion("/film.mp4", new AbortController().signal, 2, vi.fn())
    ).rejects.toThrow("byte budget")
  })
  it.each([
    new Response(new Uint8Array()),
    new Response(new Uint8Array([1]), { headers: { "content-length": "2" } }),
    new Response(null, { status: 503 }),
  ])("rejects empty, truncated or unavailable media", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response))
    await expect(
      bufferMotion("/film.mp4", new AbortController().signal, 16, vi.fn())
    ).rejects.toThrow()
  })
  it("rejects a completed result if its source was retired during download", async () => {
    const controller = new AbortController()
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(new Uint8Array([1]), { headers: { "content-length": "1" } })
        )
    )
    await expect(
      bufferMotion("/film.mp4", controller.signal, 16, () => controller.abort())
    ).rejects.toThrow()
  })
})
