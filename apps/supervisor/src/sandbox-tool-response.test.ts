import { describe, expect, it } from "vitest"
import type { BoundedConditionalObjectStore, StoredObject } from "@lyrashield/runtime-control"
import { SandboxToolResponses } from "./sandbox-tool-response"

class Store implements BoundedConditionalObjectStore {
  readonly objects = new Map<string, StoredObject>()
  loseAck = false
  async read(key: string) {
    return this.objects.get(key) ?? null
  }
  async readBounded(key: string, maxBytes: number) {
    const value = await this.read(key)
    if (value && value.bytes.byteLength > maxBytes) throw new Error("oversized")
    return value
  }
  async put(
    key: string,
    bytes: Uint8Array,
    condition: { ifNoneMatch: true } | { ifMatch: string }
  ) {
    const previous = this.objects.get(key)
    if (
      ("ifNoneMatch" in condition && previous) ||
      ("ifMatch" in condition && previous?.etag !== condition.ifMatch)
    )
      return "conflict" as const
    this.objects.set(key, { bytes: Buffer.from(bytes), etag: "one" })
    if (this.loseAck) throw new Error("write acknowledgement lost")
    return "written" as const
  }
}

const binding = {
  attemptId: "attempt-1",
  operationId: "operation-1",
  authorityEpochId: "epoch-1",
  sandboxHandle: "sandbox-1",
}
const requestId = "1d5b3040-b775-43a0-a7fb-ac5965fb91fa"
const response = {
  binding,
  requestId,
  status: "COMPLETED",
  exitCode: 0,
  stdoutBase64: "c2VjcmV0",
  stderrBase64: "",
}

describe("retained sandbox tool response", () => {
  it("encrypts, reads back and idempotently retains the exact response", async () => {
    const store = new Store(),
      retained = new SandboxToolResponses(store, "s".repeat(48))
    const proof = await retained.retain(binding, requestId, response)
    expect(proof.responseChecksum).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(await retained.load(binding, requestId, proof)).toEqual(response)
    expect(await retained.retain(binding, requestId, response)).toEqual(proof)
    expect(Buffer.from([...store.objects.values()][0]!.bytes).toString("utf8")).not.toContain(
      "c2VjcmV0"
    )
  })

  it("recovers a lost storage acknowledgement only by reading the exact encrypted response", async () => {
    const store = new Store(),
      retained = new SandboxToolResponses(store, "s".repeat(48))
    store.loseAck = true
    await expect(retained.retain(binding, requestId, response)).rejects.toThrow("acknowledgement")
    store.loseAck = false
    expect((await retained.recover(binding, requestId)).response).toEqual(response)
    const proof = await retained.retain(binding, requestId, response)
    expect(await retained.load(binding, requestId, proof)).toEqual(response)
    expect(store.objects.size).toBe(1)
  })

  it("rejects changed response bytes under the same original request", async () => {
    const store = new Store(),
      retained = new SandboxToolResponses(store, "s".repeat(48))
    await retained.retain(binding, requestId, response)
    await expect(
      retained.retain(binding, requestId, { ...response, exitCode: 1 })
    ).rejects.toThrow()
  })

  it("rejects foreign bindings, substituted proof and altered ciphertext", async () => {
    const store = new Store(),
      retained = new SandboxToolResponses(store, "s".repeat(48))
    const proof = await retained.retain(binding, requestId, response)
    await expect(
      retained.load({ ...binding, sandboxHandle: "sandbox-2" }, requestId, proof)
    ).rejects.toThrow()
    await expect(
      retained.load(binding, requestId, { ...proof, objectDigest: "0".repeat(64) })
    ).rejects.toThrow()
    const [key, value] = [...store.objects.entries()][0]!
    const changed = Buffer.from(value.bytes)
    changed[changed.length - 3] = changed[changed.length - 3]! ^ 1
    store.objects.set(key, { ...value, bytes: changed })
    await expect(retained.load(binding, requestId, proof)).rejects.toThrow()
  })

  it("rejects mismatched identity and oversized payloads before writing", async () => {
    const store = new Store(),
      retained = new SandboxToolResponses(store, "s".repeat(48))
    await expect(
      retained.retain(binding, requestId, {
        ...response,
        requestId: "b7f2c35f-82d5-4fd3-80f1-dfa5f9d49f5b",
      })
    ).rejects.toThrow()
    await expect(
      retained.retain(binding, requestId, { ...response, padding: "x".repeat(24 * 1024 * 1024) })
    ).rejects.toThrow()
    expect(store.objects.size).toBe(0)
  })
})
