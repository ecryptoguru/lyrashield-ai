import { afterEach, expect, it, vi } from "vitest"
import { bufferMotion } from "../lib/buffer-motion"

afterEach(() => vi.unstubAllGlobals())
const film = () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } })
it("refreshes a failed cached CORS request once while preserving the abort signal", async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValueOnce(film())
  vi.stubGlobal("fetch", fetch)
  const signal = new AbortController().signal
  expect((await bufferMotion("https://media.example/film.mp4", signal, 10, () => {})).size).toBe(3)
  expect(fetch.mock.calls).toEqual([
    ["https://media.example/film.mp4", { signal }],
    ["https://media.example/film.mp4", { signal, cache: "reload" }],
  ])
})
it("does not retry an aborted request", async () => {
  const controller = new AbortController()
  const fetch = vi.fn().mockImplementation(() => {
    controller.abort()
    throw new TypeError("aborted")
  })
  vi.stubGlobal("fetch", fetch)
  await expect(bufferMotion("/film", controller.signal, 10, () => {})).rejects.toThrow()
  expect(fetch).toHaveBeenCalledTimes(1)
})
it("does not retry HTTP errors or exceed the byte budget after refresh", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response("missing", { status: 404 }))
  vi.stubGlobal("fetch", fetch)
  await expect(bufferMotion("/film", new AbortController().signal, 10, () => {})).rejects.toThrow(
    "unavailable"
  )
  expect(fetch).toHaveBeenCalledTimes(1)
  fetch.mockRejectedValueOnce(new TypeError("cache")).mockResolvedValueOnce(film())
  await expect(bufferMotion("/film", new AbortController().signal, 2, () => {})).rejects.toThrow(
    "budget"
  )
})

it("stops after one refresh if delivery still fails", async () => {
  const fetch = vi.fn().mockRejectedValue(new TypeError("network unavailable"))
  vi.stubGlobal("fetch", fetch)
  await expect(bufferMotion("/film", new AbortController().signal, 10, () => {})).rejects.toThrow(
    "network unavailable"
  )
  expect(fetch).toHaveBeenCalledTimes(2)
})
