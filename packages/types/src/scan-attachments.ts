/**
 * Scan attachment contract — workspace-scoped supporting files referenced by
 * the immutable execution plan (`attachmentIds`). Attachments are immutable
 * input evidence, not configuration or instructions: the worker stages
 * checksum-verified copies read-only for the engine, and attachment content
 * can never change target scope, credentials, model routes, permissions, or
 * budget.
 *
 * v1 content policy: plain text, Markdown, JSON, YAML, and OpenAPI documents
 * only. Archives, active document formats (PDF/Office/HTML), and executables
 * are rejected — they cannot be safely surfaced to the engine sandbox as
 * inert input data.
 */

/** Per-file byte ceiling. Reuses the existing artifact-upload bound shape. */
export const SCAN_ATTACHMENT_MAX_BYTES = 1024 * 1024 // 1 MiB
/** Aggregate byte ceiling across all attachments on one scan. */
export const SCAN_ATTACHMENT_MAX_TOTAL_BYTES = 4 * 1024 * 1024 // 4 MiB
/** Matches ScanExecutionPlanSchema's attachmentIds max(20). */
export const SCAN_ATTACHMENT_MAX_COUNT = 20
/** Active attachments retained per workspace before oldest must be deleted. */
export const SCAN_ATTACHMENT_WORKSPACE_LIMIT = 200

const EXTENSION_MEDIA_TYPES: Record<string, readonly string[]> = {
  ".txt": ["text/plain"],
  ".md": ["text/markdown", "text/plain"],
  ".markdown": ["text/markdown", "text/plain"],
  ".json": [
    "application/json",
    "text/json",
    // OpenAPI documents are JSON or YAML; the vendor media types are accepted
    // only on JSON/YAML extensions.
    "application/vnd.oai.openapi+json",
  ],
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
const FORBIDDEN_EXTENSIONS = new Set([
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

export const SCAN_ATTACHMENT_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".")
  return dot === -1 ? "" : filename.slice(dot).toLowerCase()
}

export type ScanAttachmentValidation =
  | { ok: true; extension: string }
  | { ok: false; code: string }

/**
 * Validate a client-declared filename/mediaType pair against the v1 allowlist.
 * The stored media type is trusted only after this check; content is staged
 * as inert data regardless.
 */
export function validateScanAttachmentUpload(
  filename: string,
  mediaType: string,
  byteLength: number
): ScanAttachmentValidation {
  if (!SCAN_ATTACHMENT_FILENAME_PATTERN.test(filename)) {
    return { ok: false, code: "SCAN_ATTACHMENT_NAME_INVALID" }
  }
  const extension = extensionOf(filename)
  if (!extension || FORBIDDEN_EXTENSIONS.has(extension)) {
    return { ok: false, code: "SCAN_ATTACHMENT_TYPE_NOT_ALLOWED" }
  }
  const allowed = EXTENSION_MEDIA_TYPES[extension]
  if (!allowed || !allowed.includes(mediaType)) {
    return { ok: false, code: "SCAN_ATTACHMENT_TYPE_NOT_ALLOWED" }
  }
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
    return { ok: false, code: "SCAN_ATTACHMENT_EMPTY" }
  }
  if (byteLength > SCAN_ATTACHMENT_MAX_BYTES) {
    return { ok: false, code: "SCAN_ATTACHMENT_SIZE_EXCEEDED" }
  }
  return { ok: true, extension }
}

/**
 * Deterministic, collision-safe staging basename. The artifact id prefix
 * guarantees uniqueness regardless of the uploader's filename, and the
 * sanitized basename can never escape the staging directory.
 */
export function scanAttachmentStagingName(id: string, filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "attachment"
  const safe = base
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 96)
  return `${id}-${safe === "" ? "attachment" : safe}`
}
