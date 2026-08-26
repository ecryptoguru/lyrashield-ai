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

    await evidenceStorageImport.deleteEncryptedArtifact(result.storageUri, "ws-1")

    // The path came from the storage result created above, never user input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects cross-workspace local reads and deletes", async () => {
    const result = await uploadEncryptedArtifact({
      workspaceId: "ws-1",
      ownerId: "owner-1",
      type: "proof",
      content: "private",
      artifactId: "artifact-workspace",
    })

    await expect(
      evidenceStorageImport.readEncryptedArtifact(result.storageUri, "ws-2")
    ).rejects.toThrow("Evidence storage URI does not belong to workspace")
    await expect(
      evidenceStorageImport.deleteEncryptedArtifact(result.storageUri, "ws-2")
    ).rejects.toThrow("Evidence storage URI does not belong to workspace")

    const nestedLookalike = result.storageUri.replace(
      "/evidence/ws-1/",
      "/untrusted/evidence/ws-1/"
    )
    await expect(
      evidenceStorageImport.readEncryptedArtifact(nestedLookalike, "ws-1")
    ).rejects.toThrow("Evidence storage URI does not belong to workspace")
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

  it.each([
    ["workspaceId", { workspaceId: "ws-1/../ws-2" }],
    ["namespace", { namespace: "control/evidence" }],
    ["ownerId", { ownerId: "owner/other" }],
    ["type", { type: "proof/other" }],
    ["artifactId", { artifactId: "artifact/other" }],
  ])("rejects path separators in %s", async (_field, override) => {
    await expect(
      uploadEncryptedArtifact({
        workspaceId: "ws-1",
        namespace: "control-evidence",
        ownerId: "owner-1",
        type: "proof",
        artifactId: "artifact-1",
        content: "x",
        ...override,
      })
    ).rejects.toThrow("Invalid evidence storage key component")
  })
})

describe("s3 envelope encryption", () => {
  const sentCommands: { command: { input: Record<string, unknown> } }[] = []
  let storedBody: Buffer | null = null

  beforeAll(async () => {
    process.env.LYRASHIELD_LOCAL_EVIDENCE_STORAGE = "0"
    process.env.S3_ENDPOINT = "https://s3.example.test"
    process.env.S3_BUCKET = "evidence-bucket"
    process.env.S3_ACCESS_KEY = "test-access"
    process.env.S3_SECRET_KEY = "test-secret"
    process.env.LYRASHIELD_EVIDENCE_KEK = Buffer.from(new Array(32).fill(3)).toString("base64")
    vi.resetModules()
    const s3ClientProto = (await import("@aws-sdk/client-s3")).S3Client.prototype as unknown as {
      send: (command: { input: Record<string, unknown> }) => Promise<unknown>
    }
    sentCommands.length = 0
    s3ClientProto.send = async (command: { input: Record<string, unknown> }) => {
      sentCommands.push({ command })
      // PutObject carries a Body; GetObject does not — distinguish by shape.
      if (command.input["Body"] !== undefined) {
        storedBody = command.input["Body"] as Buffer
        return {}
      }
      return { Body: { transformToByteArray: async () => storedBody ?? Buffer.alloc(0) } }
    }
  })

  afterAll(() => {
    delete process.env.S3_ENDPOINT
    delete process.env.S3_BUCKET
    delete process.env.S3_ACCESS_KEY
    delete process.env.S3_SECRET_KEY
    delete process.env.LYRASHIELD_EVIDENCE_KEK
    delete process.env.LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF
    delete process.env.LYRASHIELD_EVIDENCE_KEK_KEYRING
  })

  it("uploads only envelope ciphertext and records the envelope key ref", async () => {
    vi.resetModules()
    const mod = await import("./index")
    const plaintext = Buffer.from("captured request with live session token")
    const result = await mod.uploadEncryptedArtifact({
      workspaceId: "ws-1",
      ownerId: "owner-1",
      type: "proof",
      content: plaintext,
    })

    expect(result.storageUri).toContain("s3://evidence-bucket/evidence/ws-1/")
    expect(result.encryptionKeyRef).toBe("envkeystore/lyrashield-evidence-kek/v1")
    expect(result.checkdown).toBeUndefined()
    const put = sentCommands.find((c) => c.command.input["Body"] !== undefined)?.command.input
    expect(put).toBeDefined()
    const body = put!["Body"] as Buffer
    expect(body.subarray(0, 5).toString("latin1")).toBe("LSEV1")
    expect(body.indexOf(plaintext)).toBe(-1)
  })

  it("reads an envelope object back to the exact plaintext", async () => {
    vi.resetModules()
    const mod = await import("./index")
    const plaintext = Buffer.from("decrypt me back exactly")
    await mod.uploadEncryptedArtifact({
      workspaceId: "ws-1",
      ownerId: "owner-1",
      type: "proof",
      content: plaintext,
    })
    const putBody = storedBody!

    const read = await mod.readEncryptedArtifact(
      "s3://evidence-bucket/evidence/ws-1/owner-1/proof/x",
      "ws-1"
    )
    expect(read.legacy).toBe(false)
    expect(read.content.equals(plaintext)).toBe(true)
    expect(read.checksum).toBe(createHash("sha256").update(plaintext).digest("hex"))
    expect(putBody.indexOf(plaintext)).toBe(-1)
  })

  it("reads an older envelope after activating a new KEK", async () => {
    const originalKek = Buffer.from(new Array(32).fill(3)).toString("base64")
    vi.resetModules()
    const originalMod = await import("./index")
    const plaintext = Buffer.from("retained evidence encrypted before rotation")
    await originalMod.uploadEncryptedArtifact({
      workspaceId: "ws-1",
      ownerId: "owner-1",
      type: "proof",
      content: plaintext,
    })

    process.env.LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF = "envkeystore/lyrashield-evidence-kek/v2"
    process.env.LYRASHIELD_EVIDENCE_KEK = Buffer.from(new Array(32).fill(4)).toString("base64")
    process.env.LYRASHIELD_EVIDENCE_KEK_KEYRING = JSON.stringify({
      "envkeystore/lyrashield-evidence-kek/v1": originalKek,
    })
    try {
      vi.resetModules()
      const rotatedMod = await import("./index")

      const read = await rotatedMod.readEncryptedArtifact(
        "s3://evidence-bucket/evidence/ws-1/owner-1/proof/x",
        "ws-1"
      )
      expect(read.content.equals(plaintext)).toBe(true)

      const newArtifact = await rotatedMod.uploadEncryptedArtifact({
        workspaceId: "ws-1",
        ownerId: "owner-2",
        type: "proof",
        content: "new evidence",
      })
      expect(newArtifact.encryptionKeyRef).toBe("envkeystore/lyrashield-evidence-kek/v2")
    } finally {
      process.env.LYRASHIELD_EVIDENCE_KEK = originalKek
      delete process.env.LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF
      delete process.env.LYRASHIELD_EVIDENCE_KEK_KEYRING
    }
  })

  it("rejects legacy SSE-only objects", async () => {
    vi.resetModules()
    const mod = await import("./index")
    storedBody = Buffer.from("legacy provider-SSE plaintext")
    await expect(
      mod.readEncryptedArtifact("s3://evidence-bucket/evidence/ws-1/legacy", "ws-1")
    ).rejects.toThrow("Evidence object is not envelope-encrypted")
  })

  it("rejects an envelope whose key reference was tampered", async () => {
    vi.resetModules()
    const mod = await import("./index")
    await mod.uploadEncryptedArtifact({
      workspaceId: "ws-1",
      ownerId: "owner-1",
      type: "proof",
      content: "proof",
    })
    const keyRefOffset = storedBody!.indexOf(Buffer.from(mod.EVIDENCE_KEY_REF))
    expect(keyRefOffset).toBeGreaterThan(0)
    storedBody![keyRefOffset] = storedBody![keyRefOffset] === 0x65 ? 0x66 : 0x65

    await expect(
      mod.readEncryptedArtifact("s3://evidence-bucket/evidence/ws-1/proof", "ws-1")
    ).rejects.toThrow("Evidence envelope key reference is invalid")
  })

  it("rejects cross-workspace reads and deletes", async () => {
    vi.resetModules()
    const mod = await import("./index")
    const uri = "s3://evidence-bucket/evidence/ws-1/owner-1/proof/x"

    await expect(mod.readEncryptedArtifact(uri, "ws-2")).rejects.toThrow(
      "Evidence storage URI does not belong to workspace"
    )
    await expect(mod.deleteEncryptedArtifact(uri, "ws-2")).rejects.toThrow(
      "Evidence storage URI does not belong to workspace"
    )
  })

  it("fails closed when the KEK is not configured", async () => {
    process.env.LYRASHIELD_EVIDENCE_KEK = ""
    vi.resetModules()
    const mod = await import("./index")
    expect(() => mod.assertEvidenceStorageConfigured()).toThrow()
    await expect(
      mod.uploadEncryptedArtifact({
        workspaceId: "ws-1",
        ownerId: "owner-1",
        type: "proof",
        content: Buffer.from("a"),
      })
    ).rejects.toThrow()
    process.env.LYRASHIELD_EVIDENCE_KEK = Buffer.from(new Array(32).fill(3)).toString("base64")
  })

  it("fails readiness when a configured historical KEK keyring is malformed", async () => {
    process.env.LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF = "envkeystore/lyrashield-evidence-kek/v2"
    process.env.LYRASHIELD_EVIDENCE_KEK_KEYRING = "not-json"
    try {
      vi.resetModules()
      const mod = await import("./index")
      expect(() => mod.assertEvidenceStorageConfigured()).toThrow(
        "LYRASHIELD_EVIDENCE_KEK_KEYRING is not valid JSON"
      )
    } finally {
      delete process.env.LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF
      delete process.env.LYRASHIELD_EVIDENCE_KEK_KEYRING
    }
  })

  it("fails readiness when rotation history is incomplete or reuses the active key", async () => {
    const activeKek = Buffer.from(new Array(32).fill(4)).toString("base64")
    process.env.LYRASHIELD_EVIDENCE_KEK = activeKek
    process.env.LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF = "envkeystore/lyrashield-evidence-kek/v2"
    process.env.LYRASHIELD_EVIDENCE_KEK_KEYRING = "{}"
    try {
      vi.resetModules()
      let mod = await import("./index")
      expect(() => mod.assertEvidenceStorageConfigured()).toThrow("missing a prior version")

      process.env.LYRASHIELD_EVIDENCE_KEK_KEYRING = JSON.stringify({
        "envkeystore/lyrashield-evidence-kek/v1": activeKek,
      })
      vi.resetModules()
      mod = await import("./index")
      expect(() => mod.assertEvidenceStorageConfigured()).toThrow("must differ")
    } finally {
      process.env.LYRASHIELD_EVIDENCE_KEK = Buffer.from(new Array(32).fill(3)).toString("base64")
      delete process.env.LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF
      delete process.env.LYRASHIELD_EVIDENCE_KEK_KEYRING
    }
  })
})
