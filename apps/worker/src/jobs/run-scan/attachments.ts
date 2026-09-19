import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readFile } from "node:fs/promises"
import { join } from "node:path"
import { resolveScanAttachments } from "@lyrashield/db"
import { readEncryptedArtifact } from "@lyrashield/evidence-storage"
import { scanAttachmentStagingName } from "@lyrashield/types"
import { logger } from "@lyrashield/logger"
import { engineWorkspacePath } from "../../engine/workspace-path"

/**
 * Scan attachment staging — resolve the plan's `attachmentIds` to the stored,
 * workspace-scoped objects, verify each object's sha256 against the recorded
 * checksum, and stage byte-identical copies read-only under a dedicated
 * `attachments/` input directory inside the engine workspace. A manifest the
 * engine consumes (`manifest.json`) binds every staged file to its artifact
 * identity; the engine mounts this directory read-only (engine-side contract
 * is coordinated separately — the worker never injects attachment content
 * into instructions, scope, credentials, model routing, or budget).
 */

export const SCAN_ATTACHMENT_MANIFEST_VERSION = "lyrashield-scan-attachments/1.0.0"
export const SCAN_ATTACHMENT_DIR = "attachments"

export class ScanAttachmentStagingError extends Error {
  constructor(
    readonly code:
      | "SCAN_ATTACHMENT_UNAVAILABLE"
      | "SCAN_ATTACHMENT_CHECKSUM_MISMATCH"
      | "SCAN_ATTACHMENT_STAGING",
    message: string
  ) {
    super(message)
    this.name = "ScanAttachmentStagingError"
  }
}

export interface StagedAttachmentEntry {
  /** ScanAttachment row id — the artifact identity the plan recorded. */
  id: string
  /** Original uploader filename (validated at upload; not used as a path). */
  filename: string
  /** Collision-safe basename the bytes were staged under. */
  stagedAs: string
  sha256: string
  byteLength: number
  mediaType: string
}

export interface StagedScanAttachments {
  dir: string
  manifestPath: string
  manifestChecksum: string
  entries: StagedAttachmentEntry[]
  totalBytes: number
}

function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex")
}

/**
 * Write bytes to `path` read-only, refusing symlink targets and never
 * overwriting. On EEXIST (a retried staging attempt) the existing file is
 * accepted only when its content hash matches the verified bytes exactly.
 */
async function writeReadOnlyVerified(path: string, content: Buffer, expectedSha: string) {
  let handle
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- staging path is derived from the artifact id, not caller input
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o400
    )
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "EEXIST") {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- staging path is derived from the artifact id, not caller input
      const existing = await readFile(path)
      if (sha256Hex(existing) !== expectedSha) {
        throw new ScanAttachmentStagingError(
          "SCAN_ATTACHMENT_CHECKSUM_MISMATCH",
          "Staged attachment already exists with different content"
        )
      }
      return
    }
    if (code === "ELOOP") {
      throw new ScanAttachmentStagingError(
        "SCAN_ATTACHMENT_STAGING",
        "Refusing to stage attachment over a symlink"
      )
    }
    throw error
  }
  try {
    await handle.writeFile(content)
  } finally {
    await handle.close()
  }
}

/**
 * Resolve and stage the recorded attachments for a scan. Throws
 * ScanAttachmentError (deleted/cross-workspace/over-limit rows) or
 * ScanAttachmentStagingError (checksum mismatch, unsafe staging path). The
 * caller maps these to a named failed result — a scan whose inputs cannot be
 * verified must not run against a different input set than the plan recorded.
 */
export async function stageScanAttachments(params: {
  scanId: string
  workspaceId: string
  attachmentIds: string[]
}): Promise<StagedScanAttachments | null> {
  const ids = [...new Set(params.attachmentIds)]
  if (ids.length === 0) return null

  const rows = await resolveScanAttachments(params.workspaceId, ids)

  const dir = join(engineWorkspacePath(params.scanId), SCAN_ATTACHMENT_DIR)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is derived from a validated scan id, not caller input
  await mkdir(dir, { recursive: true })
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is derived from a validated scan id, not caller input
  const dirStat = await lstat(dir)
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new ScanAttachmentStagingError(
      "SCAN_ATTACHMENT_STAGING",
      "Attachment staging path is not a real directory"
    )
  }

  const entries: StagedAttachmentEntry[] = []
  let totalBytes = 0
  for (const row of rows) {
    const artifact = await readEncryptedArtifact(row.storageUri, params.workspaceId)
    if (artifact.checksum !== row.checksum || artifact.content.byteLength !== row.byteLength) {
      throw new ScanAttachmentStagingError(
        "SCAN_ATTACHMENT_CHECKSUM_MISMATCH",
        `Attachment ${row.id} content does not match its recorded checksum`
      )
    }
    const stagedAs = scanAttachmentStagingName(row.id, row.filename)
    const targetPath = join(dir, stagedAs)
    // Defense in depth: the staging name is derived from a validated basename,
    // but never trust it — the resolved path must stay inside `dir`.
    if (!targetPath.startsWith(dir + "/") || targetPath.includes("..")) {
      throw new ScanAttachmentStagingError(
        "SCAN_ATTACHMENT_STAGING",
        "Attachment staging name escapes the input directory"
      )
    }
    await writeReadOnlyVerified(targetPath, artifact.content, row.checksum)
    entries.push({
      id: row.id,
      filename: row.filename,
      stagedAs,
      sha256: row.checksum,
      byteLength: row.byteLength,
      mediaType: row.mediaType,
    })
    totalBytes += row.byteLength
  }

  const manifest = {
    version: SCAN_ATTACHMENT_MANIFEST_VERSION,
    scanId: params.scanId,
    // The engine mounts this directory read-only; `readOnly` documents that
    // contract inside the manifest itself.
    readOnly: true,
    entries,
  }
  const manifestContent = JSON.stringify(manifest, null, 2)
  const manifestPath = join(dir, "manifest.json")
  await writeReadOnlyVerified(
    manifestPath,
    Buffer.from(manifestContent, "utf8"),
    sha256Hex(Buffer.from(manifestContent, "utf8"))
  )

  const staged: StagedScanAttachments = {
    dir,
    manifestPath,
    manifestChecksum: sha256Hex(Buffer.from(manifestContent, "utf8")),
    entries,
    totalBytes,
  }
  logger.info("Staged scan attachments", {
    scanId: params.scanId,
    count: entries.length,
    totalBytes,
  })
  return staged
}
