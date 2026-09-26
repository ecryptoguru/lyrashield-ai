/* eslint-disable security/detect-non-literal-fs-filename -- isolated tmpdir fixture files */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Output } from "../output.js"
import { handleAttachments } from "../commands/attachments.js"
import { handleFixPlan } from "../commands/fix-plan.js"

vi.mock("../credentials.js", () => ({
  getEffectiveCredentials: vi.fn(async () => ({
    apiKey: "lsk_fixture",
    apiUrl: "http://localhost:3000",
    workspaceId: "ws-test",
  })),
  requireWorkspace: vi.fn(() => "ws-test"),
}))

const output: Output = {
  json: true,
  quiet: false,
  log: vi.fn(),
  notice: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  result: vi.fn(),
  fail: (error) => {
    throw new Error(error)
  },
}

const fetchMock = vi.fn()

function respond(data: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify(status >= 400 ? { success: false, error: data } : { success: true, data }),
      { status }
    )
  )
}

const ATTACHMENT = {
  id: "att-1",
  filename: "notes.txt",
  mediaType: "text/plain",
  byteLength: 5,
  checksum: "a".repeat(64),
  createdAt: "2026-09-25T00:00:00.000Z",
}

describe("attachments command", () => {
  let dir: string
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.stubGlobal("fetch", fetchMock)
    dir = await mkdtemp(path.join(tmpdir(), "lyra-att-"))
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(dir, { recursive: true, force: true })
  })

  it("lists attachments", async () => {
    respond({ items: [ATTACHMENT] })
    expect(await handleAttachments(["list"], output)).toBe(0)
    const call = fetchMock.mock.calls[0]!
    expect(call[0]).toBe("http://localhost:3000/api/v1/scans/attachments?workspaceId=ws-test")
    expect(call[1].method).toBe("GET")
    expect(output.result).toHaveBeenCalledWith({ items: [ATTACHMENT] })
  })

  it("uploads a named file with filename/media/idempotency headers", async () => {
    const file = path.join(dir, "notes.txt")
    await writeFile(file, "hello attachment")
    respond(ATTACHMENT, 201)
    expect(await handleAttachments(["upload", file, "--idempotency-key", "up-1"], output)).toBe(0)
    const call = fetchMock.mock.calls[0]!
    expect(call[0]).toBe("http://localhost:3000/api/v1/scans/attachments?workspaceId=ws-test")
    expect(call[1].method).toBe("POST")
    const headers = call[1].headers as Record<string, string>
    expect(headers["x-lyrashield-attachment-filename"]).toBe("notes.txt")
    expect(headers["content-type"]).toBe("text/plain")
    expect(headers["Idempotency-Key"]).toBe("up-1")
    expect(new TextDecoder().decode(call[1].body as Uint8Array)).toBe("hello attachment")
    expect(output.result).toHaveBeenCalledWith(expect.objectContaining({ id: "att-1" }))
  })

  it("requires an idempotency key for upload", async () => {
    const file = path.join(dir, "notes.txt")
    await writeFile(file, "hello")
    expect(await handleAttachments(["upload", file], output)).toBe(2)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects an over-limit file without contacting the API", async () => {
    const file = path.join(dir, "big.txt")
    await writeFile(file, Buffer.alloc(1024 * 1024 + 1, 0x41))
    expect(await handleAttachments(["upload", file, "--idempotency-key", "k"], output)).toBe(2)
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining("(1 MiB)"), 2)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects a disallowed file type without contacting the API", async () => {
    const file = path.join(dir, "run.exe")
    await writeFile(file, "MZ")
    expect(await handleAttachments(["upload", file, "--idempotency-key", "k"], output)).toBe(2)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects a binary (NUL) upload without contacting the API", async () => {
    const file = path.join(dir, "notes.txt")
    await writeFile(file, Buffer.from([0x61, 0x00, 0x62]))
    const code = await handleAttachments(["upload", file, "--idempotency-key", "k"], output)
    expect(code).not.toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("errors when the upload path does not exist", async () => {
    expect(
      await handleAttachments(
        ["upload", path.join(dir, "missing.txt"), "--idempotency-key", "k"],
        output
      )
    ).toBe(2)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("removes an attachment with an idempotency key", async () => {
    respond({ id: "att-1", deleted: true })
    expect(await handleAttachments(["remove", "att-1", "--idempotency-key", "del-1"], output)).toBe(
      0
    )
    const call = fetchMock.mock.calls[0]!
    expect(call[0]).toBe("http://localhost:3000/api/v1/scans/attachments/att-1?workspaceId=ws-test")
    expect(call[1].method).toBe("DELETE")
    expect((call[1].headers as Record<string, string>)["Idempotency-Key"]).toBe("del-1")
  })

  it("requires an idempotency key for removal", async () => {
    expect(await handleAttachments(["remove", "att-1"], output)).toBe(2)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("fix-plan create-pr", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it("reports a pending approval with the approval URL", async () => {
    respond({
      status: "pending_approval",
      approvalId: "ap-1",
      approvalUrl: "https://app.lyrashieldai.com/dashboard/approvals?approval=ap-1",
    })
    expect(await handleFixPlan(["create-pr", "prop-1", "--idempotency-key", "fp-1"], output)).toBe(
      0
    )
    const call = fetchMock.mock.calls[0]!
    expect(call[0]).toBe("http://localhost:3000/api/v1/fix-proposals/prop-1/create-pr")
    expect(JSON.parse(call[1].body)).toEqual({ workspaceId: "ws-test" })
    expect(output.result).toHaveBeenCalledWith(
      expect.objectContaining({ status: "pending_approval", approvalId: "ap-1" })
    )
    expect(output.notice).toHaveBeenCalledWith(expect.stringContaining("approval=ap-1"))
  })

  it("reports an opened PR without implying a merge", async () => {
    respond({ status: "opened", prNumber: 7, prUrl: "https://github.com/o/r/pull/7" })
    expect(await handleFixPlan(["create-pr", "prop-1", "--idempotency-key", "fp-1"], output)).toBe(
      0
    )
    expect(output.notice).toHaveBeenCalledWith(expect.stringContaining("pull/7"))
  })

  it("fails honestly when the outcome is failed", async () => {
    respond({ status: "failed", reason: "approval expired" })
    expect(await handleFixPlan(["create-pr", "prop-1", "--idempotency-key", "fp-1"], output)).toBe(
      1
    )
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining("approval expired"), 1)
  })

  it("reports a rejected patch as a failure, never a success", async () => {
    respond({ code: "PATCH_REJECTED", message: "Patch failed validation" }, 422)
    expect(await handleFixPlan(["create-pr", "prop-1", "--idempotency-key", "fp-1"], output)).toBe(
      1
    )
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining("rejected"), 1)
  })

  it("requires an idempotency key", async () => {
    expect(await handleFixPlan(["create-pr", "prop-1"], output)).toBe(2)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
