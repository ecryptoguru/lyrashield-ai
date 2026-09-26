/* eslint-disable security/detect-non-literal-fs-filename -- upload reads the one file the user explicitly names */
import path from "node:path"
import { readFile, stat } from "node:fs/promises"
import minimist from "minimist"
import {
  defaultScanAttachmentMediaType,
  deleteScanAttachment,
  listScanAttachments,
  uploadScanAttachment,
  SCAN_ATTACHMENT_MAX_BYTES,
} from "@lyrashield/sdk"
import { createClient } from "../client.js"
import { getEffectiveCredentials, requireWorkspace } from "../credentials.js"
import { describeCliFailure } from "../failure.js"
import type { Output } from "../output.js"

function usage(): string {
  return `Manage workspace scan attachments (input evidence for scans).

  lyrashield attachments list --json
  lyrashield attachments upload <path> [--media-type <type>] --idempotency-key <key>
  lyrashield attachments remove <attachmentId> --idempotency-key <key>

Allowed types: .txt, .md, .markdown, .json, .yaml, .yml — plain text, Markdown,
JSON, YAML and OpenAPI documents up to 1 MiB. The uploaded attachment id can
be passed to 'lyrashield scan --attachment <id>'.`
}

/**
 * `lyrashield attachments` — list, upload and delete workspace scan
 * attachments. Upload reads one explicitly named local file: it stats before
 * reading (a >1 MiB file is rejected without being read), enforces the shared
 * filename/media-type allowlist client-side, and never shells out.
 */
export async function handleAttachments(args: string[], output: Output): Promise<number> {
  const [subcommand, ...rest] = args
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    output.notice(usage())
    return subcommand ? 0 : 2
  }
  if (!["list", "upload", "remove"].includes(subcommand)) {
    output.error(`Unknown attachments subcommand: ${subcommand}`)
    output.notice(usage())
    return 2
  }

  const workspaceId = requireWorkspace(await getEffectiveCredentials())
  const client = await createClient()

  try {
    switch (subcommand) {
      case "list": {
        const res = await listScanAttachments(client, workspaceId)
        output.result(res)
        return 0
      }
      case "upload": {
        const parsed = minimist(rest, { string: ["media-type", "idempotency-key"] })
        const [fileArg] = parsed._
        if (!fileArg) {
          output.error("usage: lyrashield attachments upload <path> --idempotency-key <key>")
          return 2
        }
        const idempotencyKey = parsed["idempotency-key"] as string | undefined
        if (!idempotencyKey?.trim()) {
          output.error(
            "--idempotency-key is required for attachment upload (a stable caller id for safe retries)"
          )
          return 2
        }
        const filePath = String(fileArg)
        const filename = path.basename(filePath)
        // Stat before reading: an over-limit file is refused without loading
        // it into memory.
        const info = await stat(filePath).catch(() => null)
        if (!info || !info.isFile()) {
          output.error(`Not a readable file: ${filePath}`)
          return 2
        }
        if (info.size <= 0) {
          output.error("Attachment is empty — nothing to upload.")
          return 2
        }
        if (info.size > SCAN_ATTACHMENT_MAX_BYTES) {
          output.error(
            `Attachment is ${info.size} bytes — over the ${SCAN_ATTACHMENT_MAX_BYTES}-byte (1 MiB) limit.`,
            2
          )
          return 2
        }
        const content = await readFile(filePath)
        const mediaType =
          (parsed["media-type"] as string | undefined) ?? defaultScanAttachmentMediaType(filename)
        if (!mediaType) {
          output.error(
            `Cannot determine an allowed media type for "${filename}". ` +
              `Attachments accept .txt, .md, .markdown, .json, .yaml and .yml only — pass --media-type to choose an allowed type.`
          )
          return 2
        }
        const res = await uploadScanAttachment(client, {
          workspaceId,
          filename,
          content: new Uint8Array(content.buffer, content.byteOffset, content.byteLength),
          mediaType,
          idempotencyKey,
        })
        output.result(res)
        output.notice(
          `Uploaded attachment ${res.id} (${filename}). Reference it on a scan with: lyrashield scan --attachment ${res.id}`
        )
        return 0
      }
      case "remove": {
        const parsed = minimist(rest, { string: ["idempotency-key"] })
        const [id] = parsed._
        if (!id) {
          output.error(
            "usage: lyrashield attachments remove <attachmentId> --idempotency-key <key>"
          )
          return 2
        }
        const idempotencyKey = parsed["idempotency-key"] as string | undefined
        if (!idempotencyKey?.trim()) {
          output.error("--idempotency-key is required for attachment removal")
          return 2
        }
        const res = await deleteScanAttachment(client, String(id), {
          workspaceId,
          idempotencyKey,
        })
        output.result(res)
        output.notice(`Attachment ${id} deleted.`)
        return 0
      }
    }
  } catch (err) {
    const { message, exitCode } = describeCliFailure(err)
    output.error(message, exitCode)
    return exitCode
  }
  return 2
}
