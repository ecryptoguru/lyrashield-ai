import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDecipheriv, createHash, hkdfSync } from "node:crypto"

describe("evidence-storage", () => {
  let tmpDir = ""
  let uploadEncryptedArtifact: typeof import("./index").uploadEncryptedArtifact
  let evidenceStorageImport: typeof import("./index")

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "evidence-storage-test-"))
    process.env.LYRASHIELD_LOCAL_EVIDENCE_STORAGE = "1"
    process.env.LYRASHIELD_LOCAL_EVIDENCE_DIR = tmpDir
    process.env.BETTER_AUTH_SECRET = "dummy-ci-only-secret-not-a-real-credential"
    vi.resetModules()
    evidenceStorageImport = await import("./index")
    uploadEncryptedArtifact = evidenceStorageImport.uploadEncryptedArtifact
  })

  it("keeps the production entry free of local filesystem imports", async () => {
    // The URL is a test-owned constant next to this file.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const source = await readFile(new URL("./index.ts", import.meta.url), "utf8")

    expect(source).not.toContain('from "node:fs/promises"')
    expect(source).not.toContain('from "node:path"')
    expect(source).not.toContain('from "node:url"')
  })

  afterAll(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it("throws a configuration error when storage is not configured", async () => {
    const original = process.env.LYRASHIELD_LOCAL_EVIDENCE_STORAGE
    process.env.LYRASHIELD_LOCAL_EVIDENCE_STORAGE = "0"
    vi.resetModules()
    const freshMod = await import("./index")
    await expect(
      freshMod.uploadEncryptedArtifact({
        workspaceId: "ws-1",
        ownerId: "owner-1",
        type: "proof",
        content: Buffer.from("a"),
      })
    ).rejects.toThrow(freshMod.EvidenceStorageConfigurationError)
    process.env.LYRASHIELD_LOCAL_EVIDENCE_STORAGE = original
    vi.resetModules()
    const mod = await import("./index")
    uploadEncryptedArtifact = mod.uploadEncryptedArtifact
    evidenceStorageImport = mod
  })

  it("stores encrypted artifacts locally without exposing raw content on disk", async () => {
    const content = Buffer.from("sensitive artifact contents")
    const result = await uploadEncryptedArtifact({
      workspaceId: "ws-1",
      ownerId: "owner-1",
      type: "proof",
      content,
      namespace: "control-evidence",
      artifactId: "artifact-1",
    })

    expect(result.byteLength).toBe(content.length)
    expect(result.checksum).toBe(createHash("sha256").update(content).digest("hex"))
    expect(result.encryptionKeyRef).toBe("local-hkdf/better-auth-secret/lyrashield-evidence/v1")
    expect(result.storageUri).toMatch(/^file:\/\//)
    expect(result.storageUri).not.toContain("s3://")

    const path = decodeURIComponent(result.storageUri.replace("file://", ""))
    // The path is derived from the storage implementation in this test and is not user-controlled.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const encrypted = await readFile(path)

    // The file must not contain the raw content.
    expect(encrypted.toString("utf8")).not.toContain("sensitive artifact contents")

    // Decrypt with the same HKDF-derived key used by the implementation.
    const key = Buffer.from(
      hkdfSync("sha256", process.env.BETTER_AUTH_SECRET!, "", "lyrashield-local-evidence-v1", 32)
    )
    const iv = encrypted.subarray(0, 12)
    const authTag = encrypted.subarray(12, 28)
    const ciphertext = encrypted.subarray(28)
    const decipher = createDecipheriv("aes-256-gcm", key, iv)
    decipher.setAuthTag(authTag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])

    expect(plaintext.toString("utf8")).toBe("sensitive artifact contents")
  })

  it("removes a local artifact during failed metadata compensation", async () => {
    const result = await uploadEncryptedArtifact({
      workspaceId: "ws-1",
      ownerId: "owner-1",
      type: "proof",
      content: "compensate me",
      artifactId: "artifact-delete",
    })
    const path = decodeURIComponent(result.storageUri.replace("file://", ""))

    await evidenceStorageImport.deleteEncryptedArtifact(result.storageUri)

    // The path came from the storage result created above, never user input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("produces deterministic checksums for string and Buffer content", async () => {
    const resultString = await uploadEncryptedArtifact({
      workspaceId: "ws-1",
      ownerId: "owner-2",
      type: "proof",
      content: "identical",
      artifactId: "artifact-2",
    })
    const resultBuffer = await uploadEncryptedArtifact({
      workspaceId: "ws-1",
      ownerId: "owner-2",
      type: "proof",
      content: Buffer.from("identical"),
      artifactId: "artifact-3",
    })

    expect(resultString.checksum).toBe(resultBuffer.checksum)
    expect(resultString.checksum).toBe(createHash("sha256").update("identical").digest("hex"))
  })

  it("keeps the same storage key shape for finding evidence without a namespace", async () => {
    const result = await uploadEncryptedArtifact({
      workspaceId: "ws-1",
      ownerId: "finding-1",
      type: "text",
      content: "x",
      artifactId: "artifact-4",
    })

    const path = decodeURIComponent(result.storageUri.replace("file://", ""))
    expect(path).toMatch(/evidence\/ws-1\/finding-1\/text\/artifact-4-[a-f0-9]{64}\.enc$/)
  })

  it("includes the namespace segment when a namespace is provided", async () => {
    const result = await uploadEncryptedArtifact({
      workspaceId: "ws-1",
      namespace: "control-evidence",
      ownerId: "version-1",
      type: "proof",
      content: "x",
      artifactId: "artifact-5",
    })

    const path = decodeURIComponent(result.storageUri.replace("file://", ""))
    expect(path).toMatch(
      /evidence\/ws-1\/control-evidence\/version-1\/proof\/artifact-5-[a-f0-9]{64}\.enc$/
    )
  })
})
