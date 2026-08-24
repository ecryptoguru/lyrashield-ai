import { beforeEach, describe, expect, it, vi } from "vitest"

const objects = new Map<string, Buffer>()
const putCounts = new Map<string, number>()

vi.mock("@aws-sdk/client-s3", () => {
  class Command {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    S3Client: class {
      async send(command: Command) {
        const key = String(command.input.Key)
        if (command.constructor.name === "PutObjectCommand") {
          objects.set(key, Buffer.from(command.input.Body as Buffer))
          putCounts.set(key, (putCounts.get(key) ?? 0) + 1)
          return {}
        }
        if (command.constructor.name === "GetObjectCommand") {
          const body = objects.get(key)
          if (!body)
            throw Object.assign(new Error("not found"), { $metadata: { httpStatusCode: 404 } })
          return { Body: { transformToByteArray: async () => body } }
        }
        if (command.constructor.name === "DeleteObjectCommand") {
          objects.delete(key)
          return {}
        }
        if (command.constructor.name === "HeadObjectCommand") {
          if (!objects.has(key)) {
            throw Object.assign(new Error("not found"), { $metadata: { httpStatusCode: 404 } })
          }
          return {}
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`)
      }
    },
    PutObjectCommand: class PutObjectCommand extends Command {},
    GetObjectCommand: class GetObjectCommand extends Command {},
    DeleteObjectCommand: class DeleteObjectCommand extends Command {},
    HeadObjectCommand: class HeadObjectCommand extends Command {},
  }
})

vi.mock("@lyrashield/config", () => ({
  env: {
    NODE_ENV: "production",
    S3_ENDPOINT: "https://s3.example.test",
    S3_BUCKET: "evidence",
    S3_ACCESS_KEY: "test-access",
    S3_SECRET_KEY: "test-secret",
    S3_REGION: "auto",
    LYRASHIELD_EVIDENCE_KEK: Buffer.alloc(32, 7).toString("base64"),
    LYRASHIELD_LOCAL_EVIDENCE_STORAGE: "0",
  },
}))

vi.mock("@lyrashield/db", () => ({ assertEvidenceEncrypted: vi.fn() }))
vi.mock("@lyrashield/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { verifyEvidenceStorage } from "./verify-evidence-storage"

describe("verifyEvidenceStorage", () => {
  beforeEach(() => {
    objects.clear()
    putCounts.clear()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })))
  })

  it("proves workspace denial, tamper rejection, unauthenticated denial, and cleanup", async () => {
    await expect(verifyEvidenceStorage()).resolves.toEqual({
      encryptedRoundTrip: true,
      crossWorkspaceDenied: true,
      tamperRejected: true,
      unauthenticatedDenied: true,
      cleanupVerified: true,
    })
    expect([...putCounts.values()].sort()).toEqual([1, 2])
    expect(objects.size).toBe(0)
  })

  it("rejects ambiguous unauthenticated failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })))

    await expect(verifyEvidenceStorage()).rejects.toThrow(
      "Evidence proof received ambiguous unauthenticated status 500"
    )
    expect(objects.size).toBe(0)
  })

  it("accepts Cloudflare R2's explicit missing-Authorization denial", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            "<Error><Code>InvalidArgument</Code><Message>Authorization</Message></Error>",
            { status: 400 }
          )
        )
    )

    await expect(verifyEvidenceStorage()).resolves.toMatchObject({
      unauthenticatedDenied: true,
      cleanupVerified: true,
    })
    expect(objects.size).toBe(0)
  })
})
