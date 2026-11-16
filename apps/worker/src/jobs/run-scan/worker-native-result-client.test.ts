import { EventEmitter } from "node:events"
import { createHash } from "node:crypto"
import { beforeEach, describe, it, expect, vi } from "vitest"
const http = vi.hoisted(() => ({ request: vi.fn(), responses: [] as unknown[] }))
vi.mock("node:http", () => ({ request: http.request }))
import { createWorkerNativeResultClient } from "./worker-native-result-client"
const credential = "fixture-private-worker-credential-no-production-authority"
beforeEach(() => {
  vi.clearAllMocks()
  http.responses = []
  http.request.mockImplementation(
    (_options: unknown, callback: (res: EventEmitter & { statusCode: number }) => void) => {
      const req = new EventEmitter() as EventEmitter & {
        end: ReturnType<typeof vi.fn>
        destroy: ReturnType<typeof vi.fn>
      }
      req.destroy = vi.fn()
      req.end = vi.fn(() =>
        queueMicrotask(() => {
          const res = Object.assign(new EventEmitter(), { statusCode: 200 })
          callback(res)
          res.emit("data", Buffer.from(JSON.stringify(http.responses.shift())))
          res.emit("end")
        })
      )
      return req
    }
  )
})
const chunk = (
  bytes: Buffer,
  offset = 0,
  totalBytes = bytes.length,
  sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`
) => ({
  kind: "available",
  operationId: "operation-one",
  attemptId: "attempt-one",
  sha256,
  totalBytes,
  offset,
  base64: bytes.toString("base64"),
  eof: offset + bytes.length === totalBytes,
})
describe("bounded worker native result transport", () => {
  it("reads actual bounded chunks with the original private worker credential", async () => {
    const bytes = Buffer.from("bounded fixture bytes"),
      sha = `sha256:${createHash("sha256").update(bytes).digest("hex")}`
    http.responses = [
      chunk(bytes.subarray(0, 7), 0, bytes.length, sha),
      chunk(bytes.subarray(7), 7, bytes.length, sha),
    ]
    expect(
      await createWorkerNativeResultClient(credential)("operation-one", "attempt-one")
    ).toEqual(bytes)
    expect(http.request).toHaveBeenCalledWith(
      expect.objectContaining({
        socketPath: "/run/lyrashield/broker.sock",
        path: "/operations/operation-one/result",
        headers: expect.objectContaining({ authorization: `Bearer ${credential}` }),
      }),
      expect.any(Function)
    )
  })
  it("retains pending output", async () => {
    http.responses = [{ kind: "pending", operationId: "operation-one", attemptId: "attempt-one" }]
    expect(
      await createWorkerNativeResultClient(credential)("operation-one", "attempt-one")
    ).toBeNull()
  })
  it.each(["scope", "offset", "digest", "empty", "truncated"])(
    "rejects %s transport substitution",
    async (failure) => {
      const value = chunk(Buffer.from("bytes"))
      if (failure === "scope") value.attemptId = "different-attempt"
      if (failure === "offset") value.offset = 1
      if (failure === "digest") value.sha256 = `sha256:${"0".repeat(64)}`
      if (failure === "empty") value.base64 = ""
      if (failure === "truncated") value.eof = false
      http.responses = [value]
      await expect(
        createWorkerNativeResultClient(credential)("operation-one", "attempt-one")
      ).rejects.toThrow()
    }
  )
})
