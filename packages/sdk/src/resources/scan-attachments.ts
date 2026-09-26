import type { LyraShieldClient } from "../client"
import { LyraShieldError } from "../errors"
import { z } from "zod"

/**
 * Scan attachment contract — workspace-scoped supporting files referenced by
 * the immutable execution plan (`attachmentIds`). The server remains the
 * authoritative validator; the checks below only fail early on input that can
 * never be accepted.
 *
 * Source of truth for the byte limit, filename pattern and media allowlist:
 * packages/types/src/scan-attachments.ts (private). This published package
 * cannot depend on @lyrashield/types — keep the duplicated constants in sync.
 */
export const SCAN_ATTACHMENT_MAX_BYTES = 1024 * 1024 // 1 MiB
export const SCAN_ATTACHMENT_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/

/** Allowed media types per attachment extension (mirrors the server allowlist). */
export const SCAN_ATTACHMENT_EXTENSION_MEDIA_TYPES: Record<string, readonly string[]> = {
  ".txt": ["text/plain"],
  ".md": ["text/markdown", "text/plain"],
  ".markdown": ["text/markdown", "text/plain"],
  ".json": ["application/json", "text/json", "application/vnd.oai.openapi+json"],
  ".yaml": [
    "application/yaml",
    "text/yaml",
    "application/x-yaml",
    "text/x-yaml",
    "application/vnd.oai.openapi",
    "application/vnd.oai.openapi+yaml",
  ],
  ".yml": [
    "application/yaml",
    "text/yaml",
    "application/x-yaml",
    "text/x-yaml",
    "application/vnd.oai.openapi",
    "application/vnd.oai.openapi+yaml",
  ],
}

/** Extensions that must never reach a scan workspace as attachments. */
const SCAN_ATTACHMENT_FORBIDDEN_EXTENSIONS = new Set([
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".jar",
  ".war",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".rtf",
  ".html",
  ".htm",
  ".svg",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".msi",
  ".bat",
  ".cmd",
  ".com",
  ".scr",
  ".ps1",
  ".sh",
  ".app",
])

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".")
  return dot === -1 ? "" : filename.slice(dot).toLowerCase()
}

/** The first (canonical) allowed media type for the filename's extension. */
export function defaultScanAttachmentMediaType(filename: string): string | undefined {
  return SCAN_ATTACHMENT_EXTENSION_MEDIA_TYPES[extensionOf(filename)]?.[0]
}

/**
 * Fields the service layer exposes for an attachment. `storageUri`,
 * `encryptionKeyRef` and other storage internals are intentionally absent —
 * the route never returns them, and this schema strips them if it ever did.
 */
const ATTACHMENT_INTERNAL_FIELDS = new Set([
  "storageUri",
  "encryptionKeyRef",
  "encryptionKeyId",
  "encryptionIv",
])

export const ScanAttachmentSummarySchema = z
  .object({
    id: z.string(),
    filename: z.string(),
    mediaType: z.string(),
    byteLength: z.number().int().nonnegative(),
    checksum: z.string(),
    createdAt: z.string(),
  })
  .passthrough()
  .transform((attachment) => {
    const safe = { ...attachment }
    for (const key of ATTACHMENT_INTERNAL_FIELDS) delete safe[key]
    return safe
  })

export type ScanAttachmentSummary = z.infer<typeof ScanAttachmentSummarySchema>

export const ScanAttachmentListSchema = z
  .object({ items: z.array(ScanAttachmentSummarySchema) })
  .passthrough()

const ScanAttachmentDeleteResultSchema = z
  .object({ id: z.string(), deleted: z.literal(true) })
  .passthrough()

/**
 * The create-pr outcome. The API returns 200 for `pending_approval`,
 * `opened` and `failed`; a `rejected` patch is a 422 `PATCH_REJECTED` error
 * (surfaced as LyraShieldError), so the status distinction is always honest —
 * a success payload here can never be a rejection in disguise.
 */
export const FixPrOutcomeSchema = z
  .object({
    status: z.enum(["pending_approval", "opened", "rejected", "failed"]),
    approvalId: z.string().optional(),
    approvalUrl: z.string().optional(),
    prNumber: z.number().optional(),
    prUrl: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough()

export type FixPrOutcome = z.infer<typeof FixPrOutcomeSchema>

function attachmentError(code: string, message: string): LyraShieldError {
  return new LyraShieldError({ status: 0, code, message })
}

function workspaceQuery(client: LyraShieldClient, workspaceId?: string): string {
  const ws = workspaceId ?? client.workspaceId
  const params = new URLSearchParams()
  if (ws) params.set("workspaceId", ws)
  const qs = params.toString()
  return qs ? `?${qs}` : ""
}

export function listScanAttachments(
  client: LyraShieldClient,
  workspaceId?: string,
  options?: { signal?: AbortSignal }
): Promise<z.infer<typeof ScanAttachmentListSchema>> {
  return client.request("GET", `/scans/attachments${workspaceQuery(client, workspaceId)}`, {
    signal: options?.signal,
    parse: (data) => ScanAttachmentListSchema.parse(data),
  })
}

export interface UploadScanAttachmentInput {
  workspaceId?: string
  filename: string
  /** Attachment bytes — a UTF-8 string or an explicit Uint8Array. */
  content: Uint8Array | string
  /** Declared media type; must be allowed for the filename's extension. */
  mediaType: string
  /** Forwarded as the Idempotency-Key header; the server binds a durable operation record. */
  idempotencyKey?: string
  signal?: AbortSignal
}

/**
 * Client-side pre-flight validation for attachment uploads — UX only; the
 * server re-checks everything and stays authoritative. Throws a
 * LyraShieldError with the same code the server would return.
 */
export function validateScanAttachmentUploadClient(
  filename: string,
  mediaType: string,
  byteLength: number
): void {
  if (!SCAN_ATTACHMENT_FILENAME_PATTERN.test(filename)) {
    throw attachmentError(
      "SCAN_ATTACHMENT_NAME_INVALID",
      "Attachment filename must be 1-128 characters of letters, digits, dots, dashes, underscores or spaces and may not contain a path."
    )
  }
  const extension = extensionOf(filename)
  if (!extension || SCAN_ATTACHMENT_FORBIDDEN_EXTENSIONS.has(extension)) {
    throw attachmentError(
      "SCAN_ATTACHMENT_TYPE_NOT_ALLOWED",
      `Attachment type "${extension || "(none)"}" is not allowed.`
    )
  }
  const allowed = SCAN_ATTACHMENT_EXTENSION_MEDIA_TYPES[extension]
  if (!allowed || !allowed.includes(mediaType)) {
    throw attachmentError(
      "SCAN_ATTACHMENT_TYPE_NOT_ALLOWED",
      `Media type "${mediaType}" is not allowed for ${extension} attachments. Allowed: ${(allowed ?? []).join(", ") || "none"}.`
    )
  }
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
    throw attachmentError("SCAN_ATTACHMENT_EMPTY", "Attachment body is required")
  }
  if (byteLength > SCAN_ATTACHMENT_MAX_BYTES) {
    throw attachmentError(
      "SCAN_ATTACHMENT_SIZE_EXCEEDED",
      `Attachment exceeds the ${SCAN_ATTACHMENT_MAX_BYTES}-byte limit`
    )
  }
}

export async function uploadScanAttachment(
  client: LyraShieldClient,
  input: UploadScanAttachmentInput
): Promise<ScanAttachmentSummary> {
  const bytes =
    typeof input.content === "string" ? new TextEncoder().encode(input.content) : input.content
  validateScanAttachmentUploadClient(input.filename, input.mediaType, bytes.byteLength)
  if (bytes.includes(0)) {
    throw attachmentError(
      "SCAN_ATTACHMENT_TYPE_NOT_ALLOWED",
      "Binary content is not an allowed attachment"
    )
  }
  const headers: Record<string, string> = {
    "content-type": input.mediaType,
    "x-lyrashield-attachment-filename": encodeURIComponent(input.filename),
  }
  if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey
  return client.request("POST", `/scans/attachments${workspaceQuery(client, input.workspaceId)}`, {
    rawBody: bytes,
    headers,
    signal: input.signal,
    parse: (data) => ScanAttachmentSummarySchema.parse(data),
  })
}

export function deleteScanAttachment(
  client: LyraShieldClient,
  attachmentId: string,
  options?: { workspaceId?: string; idempotencyKey?: string; signal?: AbortSignal }
): Promise<z.infer<typeof ScanAttachmentDeleteResultSchema>> {
  const headers: Record<string, string> = {}
  if (options?.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey
  return client.request(
    "DELETE",
    `/scans/attachments/${encodeURIComponent(attachmentId)}${workspaceQuery(client, options?.workspaceId)}`,
    {
      headers: Object.keys(headers).length ? headers : undefined,
      signal: options?.signal,
      parse: (data) => ScanAttachmentDeleteResultSchema.parse(data),
    }
  )
}

export function requestFixPr(
  client: LyraShieldClient,
  proposalId: string,
  options?: { workspaceId?: string; idempotencyKey?: string; signal?: AbortSignal }
): Promise<FixPrOutcome> {
  const workspaceId = options?.workspaceId ?? client.workspaceId
  const headers: Record<string, string> = {}
  if (options?.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey
  return client.request("POST", `/fix-proposals/${encodeURIComponent(proposalId)}/create-pr`, {
    body: workspaceId ? { workspaceId } : {},
    headers: Object.keys(headers).length ? headers : undefined,
    signal: options?.signal,
    parse: (data) => FixPrOutcomeSchema.parse(data),
  })
}
