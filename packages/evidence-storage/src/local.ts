/* eslint-disable security/detect-non-literal-fs-filename -- paths are resolved below the configured evidence root */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { env } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"
import type { UploadEncryptedArtifactResult } from "./index.js"

const LOCAL_EVIDENCE_KEY_INFO = "lyrashield-local-evidence-v1"

function toBuffer(content: string | Buffer): Buffer {
  return Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8")
}

function getLocalEvidencePath(key: string): string {
  const root = resolve(
    env.LYRASHIELD_LOCAL_EVIDENCE_DIR || join(process.cwd(), ".lyrashield", "evidence")
  )
  const path = resolve(root, `${key}.enc`)
  const pathFromRoot = relative(root, path)
  if (pathFromRoot === "" || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
    throw new Error("Invalid local evidence path")
  }
  return path
}

function encryptLocalEvidence(content: string | Buffer): Buffer {
  // ponytail: derive a purpose-specific local key from the required dev secret; add a dedicated key only if local key rotation is needed.
  const key = Buffer.from(
    hkdfSync("sha256", env.BETTER_AUTH_SECRET, "", LOCAL_EVIDENCE_KEY_INFO, 32)
  )
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const payload = toBuffer(content)
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
}

export async function storeLocalEvidence(
  key: string,
  content: string | Buffer,
  checksum: string,
  encryptionKeyRef: string
): Promise<UploadEncryptedArtifactResult> {
  const path = getLocalEvidencePath(key)
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  const payload = toBuffer(content)
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(temporaryPath, encryptLocalEvidence(payload), { mode: 0o600 })
    await rename(temporaryPath, path)
    await chmod(path, 0o600)
    return {
      storageUri: pathToFileURL(path).toString(),
      checksum,
      encryptionKeyRef,
      byteLength: payload.length,
    }
  } catch (err) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    logger.error("Failed to store local evidence", {
      error: err instanceof Error ? err.message : String(err),
    })
    throw new Error("Failed to store local evidence", { cause: err })
  }
}

function resolveLocalEvidenceUri(storageUri: string, expectedWorkspaceId: string): string {
  const path = resolve(fileURLToPath(storageUri))
  const root = resolve(
    env.LYRASHIELD_LOCAL_EVIDENCE_DIR || join(process.cwd(), ".lyrashield", "evidence")
  )
  const pathFromRoot = relative(root, path)
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    !path.endsWith(".enc") ||
    !pathFromRoot.startsWith(`evidence${sep}${expectedWorkspaceId}${sep}`)
  ) {
    throw new Error("Evidence storage URI does not belong to workspace")
  }
  return path
}

/** Remove a local artifact when its immutable database version cannot be saved. */
export async function deleteLocalEvidence(
  storageUri: string,
  expectedWorkspaceId: string
): Promise<void> {
  const path = resolveLocalEvidenceUri(storageUri, expectedWorkspaceId)
  await rm(path, { force: true })
}

/** Read a local artifact back, decrypting the iv||tag||ciphertext envelope. */
export async function readLocalEvidence(
  storageUri: string,
  expectedWorkspaceId: string
): Promise<Buffer> {
  const path = resolveLocalEvidenceUri(storageUri, expectedWorkspaceId)
  const key = Buffer.from(
    hkdfSync("sha256", env.BETTER_AUTH_SECRET, "", LOCAL_EVIDENCE_KEY_INFO, 32)
  )
  const raw = await readFile(path)
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(12, 28)
  const ciphertext = raw.subarray(28)
  const decipher = createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}
