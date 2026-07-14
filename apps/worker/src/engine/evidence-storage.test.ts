import { createDecipheriv, hkdfSync } from "node:crypto"
import { readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const send = vi.fn()
const evidenceEnv = vi.hoisted(() => ({
  S3_ENDPOINT: undefined as string | undefined,
  S3_BUCKET: undefined as string | undefined,
  S3_ACCESS_KEY: undefined as string | undefined,
  S3_SECRET_KEY: undefined as string | undefined,
  S3_REGION: undefined as string | undefined,
  NODE_ENV: "test",
  LYRASHIELD_LOCAL_EVIDENCE_STORAGE: "0",
  LYRASHIELD_LOCAL_EVIDENCE_DIR: "",
  BETTER_AUTH_SECRET: "a".repeat(32),
}))

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = send
  },
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
}))

vi.mock("@lyrashield/config", () => ({
  env: evidenceEnv,
}))

vi.mock("@lyrashield/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}))

const { uploadEvidence, EvidenceStorageConfigurationError } = await import("./evidence-storage")

describe("uploadEvidence", () => {
  const localDir = join(tmpdir(), `lyrashield-evidence-test-${Date.now()}`)

  beforeEach(() => {
    send.mockReset()
    Object.assign(evidenceEnv, {
      S3_ENDPOINT: undefined,
      S3_BUCKET: undefined,
      S3_ACCESS_KEY: undefined,
      S3_SECRET_KEY: undefined,
      S3_REGION: undefined,
      NODE_ENV: "test",
      LYRASHIELD_LOCAL_EVIDENCE_STORAGE: "0",
      LYRASHIELD_LOCAL_EVIDENCE_DIR: localDir,
      BETTER_AUTH_SECRET: "a".repeat(32),
    })
  })

  afterEach(async () => rm(localDir, { recursive: true, force: true }))

  it("fails closed when durable evidence storage is not configured", async () => {
    await expect(
      uploadEvidence({
        workspaceId: "ws-1",
        findingId: "finding-1",
        type: "poc",
        content: "proof",
      })
    ).rejects.toBeInstanceOf(EvidenceStorageConfigurationError)
  })

  it("stores encrypted evidence locally only when explicitly enabled outside production", async () => {
    evidenceEnv.LYRASHIELD_LOCAL_EVIDENCE_STORAGE = "1"
    const result = await uploadEvidence({
      workspaceId: "ws-1",
      findingId: "finding-1",
      type: "poc",
      artifactId: "proof",
      content: "sensitive proof",
    })

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- result URI is produced by uploadEvidence
    const encrypted = await readFile(fileURLToPath(result.storageUri))
    expect(encrypted.toString("utf8")).not.toContain("sensitive proof")
    const key = Buffer.from(
      hkdfSync("sha256", evidenceEnv.BETTER_AUTH_SECRET, "", "lyrashield-local-evidence-v1", 32)
    )
    const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(0, 12))
    decipher.setAuthTag(encrypted.subarray(12, 28))
    expect(
      Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString()
    ).toBe("sensitive proof")
    expect(result.encryptionKeyRef).toMatch(/^local-hkdf:/)
  })

  it("does not permit the local store in production", async () => {
    evidenceEnv.LYRASHIELD_LOCAL_EVIDENCE_STORAGE = "1"
    evidenceEnv.NODE_ENV = "production"

    await expect(
      uploadEvidence({
        workspaceId: "ws-1",
        findingId: "finding-1",
        type: "poc",
        content: "proof",
      })
    ).rejects.toBeInstanceOf(EvidenceStorageConfigurationError)
  })
})
