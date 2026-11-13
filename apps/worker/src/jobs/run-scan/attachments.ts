import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, mkdtemp, open, rename, rm, rmdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { addScanEvent, resolveScanAttachments, ScanAttachmentError } from "@lyrashield/db"
import { readEncryptedArtifact } from "@lyrashield/evidence-storage"
import { scanAttachmentStagingName, SCAN_ATTACHMENT_MAX_TOTAL_BYTES } from "@lyrashield/types"
import { logger } from "@lyrashield/logger"
import type { ScanJobResult } from "../../types"
import { engineWorkspacePath } from "../../engine/workspace-path"

/**
 * Verify plan-bound attachment bytes in private worker memory. After paid
 * admission, publish the complete input tree and manifest for the engine’s
 * read-only mount. Attachment content never configures the scan or its budget.
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

interface StagedAttachmentEntry {
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
  publish(): Promise<void>
  handoff(): void
  [Symbol.asyncDispose](): Promise<void>
}

function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex")
}

/** Returns an attempt-private, bounded plaintext resource. Disk publication belongs to the paid owner. */
export async function stageScanAttachments(params: {
  scanId: string
  workspaceId: string
  attachmentIds: string[]
}): Promise<StagedScanAttachments | null> {
  const ids = [...new Set(params.attachmentIds)]
  if (ids.length === 0) return null
  const workspace = engineWorkspacePath(params.scanId)
  const dir = join(workspace, SCAN_ATTACHMENT_DIR)
  const rows = await resolveScanAttachments(params.workspaceId, ids)
  const entries: StagedAttachmentEntry[] = []
  const files = new Map<string, Buffer>()
  let totalBytes = 0
  const wipe = () => {
    for (const content of files.values()) content.fill(0)
    files.clear()
  }
  try {
    for (const row of rows) {
      const { content, checksum } = await readEncryptedArtifact(row.storageUri, params.workspaceId)
      const stagedAs = scanAttachmentStagingName(row.id, row.filename)
      if (dirname(join(dir, stagedAs)) !== dir || stagedAs.includes("..") || files.has(stagedAs)) {
        throw new ScanAttachmentStagingError(
          "SCAN_ATTACHMENT_STAGING",
          "Invalid attachment staging name"
        )
      }
      totalBytes += content.byteLength
      if (
        totalBytes > SCAN_ATTACHMENT_MAX_TOTAL_BYTES ||
        content.byteLength !== row.byteLength ||
        checksum !== row.checksum ||
        sha256Hex(content) !== row.checksum
      ) {
        throw new ScanAttachmentStagingError(
          "SCAN_ATTACHMENT_CHECKSUM_MISMATCH",
          `Attachment ${row.id} content does not match its recorded checksum`
        )
      }
      // Keep a private copy: disposing one delivery must not mutate another reader's buffer.
      files.set(stagedAs, Buffer.from(content))
      entries.push({
        id: row.id,
        filename: row.filename,
        stagedAs,
        sha256: row.checksum,
        byteLength: row.byteLength,
        mediaType: row.mediaType,
      })
    }
    const manifest = Buffer.from(
      JSON.stringify(
        {
          version: SCAN_ATTACHMENT_MANIFEST_VERSION,
          scanId: params.scanId,
          readOnly: true,
          entries,
        },
        null,
        2
      )
    )
    const manifestChecksum = sha256Hex(manifest)
    files.set("manifest.json", manifest)
    let discardPublication: (() => Promise<void>) | undefined
    let publicationStarted = false
    return {
      dir,
      manifestPath: join(dir, "manifest.json"),
      manifestChecksum,
      entries,
      totalBytes,
      async publish() {
        if (publicationStarted || !files.size)
          throw new ScanAttachmentStagingError(
            "SCAN_ATTACHMENT_STAGING",
            "Prepared attachment bytes are unavailable"
          )
        publicationStarted = true
        try {
          discardPublication = await publishVerifiedDirectory(workspace, dir, files)
        } finally {
          wipe()
        }
      },
      handoff() {
        discardPublication = undefined
      },
      async [Symbol.asyncDispose]() {
        wipe()
        const discard = discardPublication
        discardPublication = undefined
        await discard?.()
      },
    }
  } catch (error) {
    wipe()
    throw error
  }
}

async function publishVerifiedDirectory(
  workspace: string,
  dir: string,
  files: Map<string, Buffer>
) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- validated engine workspace
  const created = await mkdir(workspace, { recursive: true })
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- capture parent identity before publication
  const parent = await lstat(workspace)
  if (!parent.isDirectory())
    throw new ScanAttachmentStagingError(
      "SCAN_ATTACHMENT_STAGING",
      "Invalid engine workspace directory"
    )
  const removeEmptyParent = async () => {
    if (!created || !(await sameDirectory(workspace, parent))) return
    // Remove only an empty directory created by this attempt.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- verified parent inode
    await rmdir(workspace).catch((error: NodeJS.ErrnoException) => {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code ?? "")) throw error
    })
  }
  let temp: string | undefined
  try {
    // No existing input tree belongs to this attempt.
    if (await statIfPresent(dir))
      throw new ScanAttachmentStagingError(
        "SCAN_ATTACHMENT_STAGING",
        "Attachment directory already exists"
      )
    temp = await mkdtemp(join(workspace, ".attachments-"))
    for (const [name, content] of files) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- validated basename in attempt-private directory
      const handle = await open(
        join(temp, name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o400
      )
      try {
        await handle.writeFile(content)
      } finally {
        await handle.close()
      }
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- capture identity before publication
    const identity = await lstat(temp)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- atomic same-filesystem handoff of the complete tree
    await rename(temp, dir)
    return async () => {
      if (await sameDirectory(dir, identity)) await rm(dir, { recursive: true, force: true })
      await removeEmptyParent()
    }
  } catch (error) {
    if (temp) await rm(temp, { recursive: true, force: true })
    await removeEmptyParent()
    throw error
  }
}

async function statIfPresent(path: string) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller supplies a validated workspace path
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
}

async function sameDirectory(path: string, owned: { dev: number; ino: number }): Promise<boolean> {
  const current = await statIfPresent(path)
  return Boolean(current && current.dev === owned.dev && current.ino === owned.ino)
}

export async function attachmentFailure(
  scanId: string,
  workspaceId: string,
  error: unknown
): Promise<{ ok: false; result: ScanJobResult }> {
  const known = error instanceof ScanAttachmentError || error instanceof ScanAttachmentStagingError
  const code = known ? error.code : "SCAN_ATTACHMENT_UNAVAILABLE"
  logger.warn("Scan attachment staging failed", { scanId, workspaceId, code })
  try {
    await addScanEvent(
      scanId,
      "attachments_failed",
      "error",
      "A supporting file could not be verified or is no longer available",
      { code }
    )
  } catch (eventErr) {
    logger.warn("Failed to persist attachments_failed event", {
      scanId,
      error: eventErr instanceof Error ? eventErr.name : "UNKNOWN",
    })
  }
  return {
    ok: false,
    result: {
      status: "failed",
      errorCategory: code,
      errorMessage:
        "A supporting file could not be verified or is no longer available. Re-upload it and start a new scan.",
    },
  }
}
