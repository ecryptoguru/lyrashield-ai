import { createDecipheriv, hkdfSync } from "node:crypto"
import { readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const send = vi.fn()
const evidenceEnv = vi.hoisted(() => ({
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
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
  isDev: false,
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
    expect(result.encryptionKeyRef).toBe("local-hkdf/better-auth-secret/lyrashield-evidence/v1")
  })

  it("does not overwrite a prior artifact when content changes", async () => {
    evidenceEnv.LYRASHIELD_LOCAL_EVIDENCE_STORAGE = "1"
    const first = await uploadEvidence({
      workspaceId: "ws-1",
      findingId: "finding-1",
      type: "poc",
      artifactId: "same-artifact",
      content: "first proof",
    })
    const second = await uploadEvidence({
      workspaceId: "ws-1",
      findingId: "finding-1",
      type: "poc",
      artifactId: "same-artifact",
      content: "second proof",
    })

    expect(first.storageUri).not.toBe(second.storageUri)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- both URIs are produced by uploadEvidence
    expect(await readFile(fileURLToPath(first.storageUri))).not.toEqual(
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- both URIs are produced by uploadEvidence
      await readFile(fileURLToPath(second.storageUri))
    )
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

  it("requests explicit AES-256 encryption from ordinary S3-compatible stores", async () => {
    Object.assign(evidenceEnv, {
      S3_ENDPOINT: "https://s3.example.test",
      S3_BUCKET: "evidence",
      S3_ACCESS_KEY: "access-key",
      S3_SECRET_KEY: "secret-key",
      NODE_ENV: "production",
    })

    await uploadEvidence({
      workspaceId: "ws-1",
      findingId: "finding-1",
      type: "poc",
      artifactId: "proof",
      content: "sensitive proof",
    })

    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      Bucket: "evidence",
      ServerSideEncryption: "AES256",
      ChecksumSHA256: expect.any(String),
    })
  })

  it("uses R2 provider-managed encryption without sending its unsupported S3 option", async () => {
    Object.assign(evidenceEnv, {
      S3_ENDPOINT: "https://account-id.eu.r2.cloudflarestorage.com",
      S3_BUCKET: "evidence",
      S3_ACCESS_KEY: "access-key",
      S3_SECRET_KEY: "secret-key",
      NODE_ENV: "production",
    })

    await uploadEvidence({
      workspaceId: "ws-1",
      findingId: "finding-1",
      type: "poc",
      artifactId: "proof",
      content: "sensitive proof",
    })

    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      Bucket: "evidence",
      ChecksumSHA256: expect.any(String),
    })
    expect(send.mock.calls[0]?.[0].input).not.toHaveProperty("ServerSideEncryption")
  })
})
