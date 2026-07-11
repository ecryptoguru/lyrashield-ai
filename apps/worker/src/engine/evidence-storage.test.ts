import { beforeEach, describe, expect, it, vi } from "vitest"

const send = vi.fn()

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = send
  },
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
}))

vi.mock("@lyrashield/config", () => ({
  env: {
    S3_ENDPOINT: undefined,
    S3_BUCKET: undefined,
    S3_ACCESS_KEY: undefined,
    S3_SECRET_KEY: undefined,
    S3_REGION: undefined,
  },
}))

vi.mock("@lyrashield/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}))

const { uploadEvidence } = await import("./evidence-storage")

describe("uploadEvidence", () => {
  beforeEach(() => send.mockReset())

  it("fails closed when durable evidence storage is not configured", async () => {
    await expect(
      uploadEvidence({
        workspaceId: "ws-1",
        findingId: "finding-1",
        type: "poc",
        content: "proof",
      })
    ).rejects.toThrow("Evidence storage is not configured")
  })
})
