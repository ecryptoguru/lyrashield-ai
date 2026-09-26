/* eslint-disable security/detect-non-literal-fs-filename -- user explicitly names the local attachment; stat and read are size-checked before upload */
import { readFile, stat } from "node:fs/promises"
import { basename, extname } from "node:path"
import minimist from "minimist"
import { deleteScanAttachment, listScanAttachments, uploadScanAttachment } from "@lyrashield/sdk"
import { createClient } from "../client.js"
import { getEffectiveCredentials, requireWorkspace } from "../credentials.js"
import type { Output } from "../output.js"

const MAX_BYTES = 1024 * 1024
const MEDIA_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
}

export async function handleAttachments(args: string[], output: Output): Promise<number> {
  const [action, ...rest] = args
  const parsed = minimist(rest, { string: ["idempotency-key"] })
  const [value] = parsed._ as string[]
  if (
    !action ||
    !["list", "upload", "remove"].includes(action) ||
    (action === "list" ? parsed._.length !== 0 : parsed._.length !== 1)
  ) {
    output.error("usage: lyrashield attachments list | upload <file> | remove <attachmentId>")
    return 2
  }
  const key = parsed["idempotency-key"] as string | undefined
  if (key !== undefined && !key.trim()) {
    output.error("--idempotency-key must be non-empty")
    return 2
  }

  let content: Uint8Array | undefined
  let filename: string | undefined
  let mediaType: string | undefined
  if (action === "upload") {
    filename = basename(value!)
    mediaType = MEDIA_TYPES[extname(filename).toLowerCase()]
    if (!mediaType) {
      output.error("Attachment must be .txt, .md, .markdown, .json, .yaml, or .yml")
      return 2
    }
    const metadata = await stat(value!)
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_BYTES) {
      output.error("Attachment must be a regular file from 1 byte to 1 MiB")
      return 2
    }
    content = await readFile(value!)
    if (content.byteLength < 1 || content.byteLength > MAX_BYTES) {
      output.error("Attachment changed while reading or exceeds 1 MiB")
      return 2
    }
  }

  const workspaceId = requireWorkspace(await getEffectiveCredentials())
  const client = await createClient()
  const result =
    action === "list"
      ? await listScanAttachments(client, workspaceId)
      : action === "upload"
        ? await uploadScanAttachment(client, {
            workspaceId,
            filename: filename!,
            mediaType: mediaType!,
            content: content!,
            idempotencyKey: key,
          })
        : await deleteScanAttachment(client, value!, { workspaceId, idempotencyKey: key })
  output.result(result)
  return 0
}
