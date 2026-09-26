/* eslint-disable security/detect-non-literal-fs-filename -- files live in a test-owned temporary directory */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { handleAttachments } from "../commands/attachments.js"
import type { Output } from "../output.js"
import { createClient } from "../client.js"
import { uploadScanAttachment } from "@lyrashield/sdk"

vi.mock("../client.js", () => ({ createClient: vi.fn().mockResolvedValue({}) }))
vi.mock("../credentials.js", () => ({
  getEffectiveCredentials: vi.fn().mockResolvedValue({ workspaceId: "ws-1" }),
  requireWorkspace: vi.fn((value: { workspaceId: string }) => value.workspaceId),
}))
vi.mock("@lyrashield/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lyrashield/sdk")>()),
  uploadScanAttachment: vi.fn().mockResolvedValue({ id: "attachment-1" }),
  listScanAttachments: vi.fn().mockResolvedValue([]),
  deleteScanAttachment: vi.fn().mockResolvedValue({ id: "attachment-1", deleted: true }),
}))

const output = { result: vi.fn(), error: vi.fn() } as unknown as Output
let directory: string

beforeEach(async () => {
  vi.clearAllMocks()
  directory = await mkdtemp(join(tmpdir(), "lyrashield-attachment-test-"))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it("uploads only explicit bounded file bytes", async () => {
  const file = join(directory, "context.md")
  await writeFile(file, "synthetic review context")
  expect(await handleAttachments(["upload", file, "--idempotency-key", "request-1"], output)).toBe(
    0
  )
  expect(uploadScanAttachment).toHaveBeenCalledWith(
    await createClient(),
    expect.objectContaining({
      workspaceId: "ws-1",
      filename: "context.md",
      mediaType: "text/markdown",
      content: Buffer.from("synthetic review context"),
      idempotencyKey: "request-1",
    })
  )
})

it("rejects oversized files before creating a client", async () => {
  const file = join(directory, "large.txt")
  await writeFile(file, Buffer.alloc(1024 * 1024 + 1))
  expect(await handleAttachments(["upload", file], output)).toBe(2)
  expect(createClient).not.toHaveBeenCalled()
})
