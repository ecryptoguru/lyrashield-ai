import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createProtectedSupervisorReceiptAuthority } from "./scan-supervisor-receipt-source"

const originalSigningSecret = "a".repeat(32),
  wrapperSigningSecret = "b".repeat(32)
const options = {
  connectionString: "postgres://restricted@localhost/disposable",
  streamId: "stream-test",
  authorityEpochId: "epoch-test",
  supervisorInstanceId: "supervisor-test",
  originalSigningSecret,
  wrapperSigningSecret,
  originalKeyHash: createHash("sha256").update(originalSigningSecret).digest("hex"),
  wrapperKeyHash: createHash("sha256").update(wrapperSigningSecret).digest("hex"),
  controlToken: "t".repeat(32),
}
const cursor = {
  epochId: options.authorityEpochId,
  supervisorInstanceId: options.supervisorInstanceId,
  afterSequence: 0,
  afterHash: "0".repeat(64),
  limit: 64,
}

describe("protected supervisor journal source", () => {
  it("reads the private socket with exact scope and authenticated fixed-head continuation", async () => {
    const root = await mkdtemp(join(tmpdir(), "receipt-source-")),
      socketPath = join(root, "control.sock")
    const server = createServer((request, response) => {
      expect(request.headers.authorization).toBe(`Bearer ${options.controlToken}`)
      const url = new URL(request.url!, "http://local")
      expect(url.pathname).toBe("/v1/journal")
      expect(url.searchParams.get("snapshotSequence")).toBe("12")
      expect(url.searchParams.get("snapshotHash")).toBe("f".repeat(64))
      response.writeHead(200, { "content-type": "application/json" })
      response.end('{"signed":"page"}')
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    try {
      const source = createProtectedSupervisorReceiptAuthority({
        ...options,
        transport: { kind: "unix", socketPath },
      })
      expect(
        await source.readJournal({ ...cursor, snapshotSequence: 12, snapshotHash: "f".repeat(64) })
      ).toEqual({ signed: "page" })
      expect(() => source.readJournal({ ...cursor, epochId: "foreign" })).toThrow(
        "Supervisor receipt authority"
      )
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })
  it("rejects caller-selected remote endpoints and key mismatch before I/O", () => {
    expect(() =>
      createProtectedSupervisorReceiptAuthority({
        ...options,
        transport: { kind: "url", url: "https://example.com" },
      })
    ).toThrow()
    expect(() =>
      createProtectedSupervisorReceiptAuthority({
        ...options,
        originalKeyHash: "0".repeat(64),
        transport: { kind: "unix", socketPath: "/unused" },
      })
    ).toThrow()
  })
  it("does not follow redirects or accept unsigned error response bodies", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(302, {
        location: "https://example.com",
        "content-type": "application/json",
      })
      response.end('{"secret":"private"}')
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("listener unavailable")
      const source = createProtectedSupervisorReceiptAuthority({
        ...options,
        transport: { kind: "loopback", port: address.port },
      })
      await expect(source.readJournal(cursor)).rejects.toThrow("SUPERVISOR_SOURCE_READ_UNAVAILABLE")
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
