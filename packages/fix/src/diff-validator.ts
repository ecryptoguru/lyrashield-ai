/**
 * Diff validator for the WP3 fix-PR pipeline.
 *
 * The single most important control in the pipeline: a patch may only touch
 * what the finding it fixes is about, enforced mechanically. A diff that fails
 * any rule is rejected with a named reason and never reaches a human as viable.
 *
 * Fail-closed: if the diff cannot be parsed, or any check itself errors, the
 * result is a rejection — never a silent pass.
 */

import type { PatchScopePolicy } from "./scope-policy"

export type DiffRejectCode =
  | "EMPTY_DIFF"
  | "UNPARSEABLE"
  | "PATH_OUT_OF_SCOPE"
  | "FORBIDDEN_PATH"
  | "NEW_FILE_OUT_OF_SCOPE"
  | "DELETE_NOT_ALLOWED"
  | "TOO_MANY_LINES"
  | "BINARY_NOT_ALLOWED"
  | "LOCKFILE_NOT_ALLOWED"
  | "SECRET_LIKE_CONTENT"
  | "VALIDATION_ERROR"

export interface DiffValidationOk {
  ok: true
  /** Files the diff touches (repo-relative, forward-slash). */
  filesTouched: string[]
  /** Total added + removed lines. */
  linesTouched: number
}

export interface DiffValidationRejected {
  ok: false
  code: DiffRejectCode
  reason: string
}

export type DiffValidation = DiffValidationOk | DiffValidationRejected

/** Paths a patch may never touch, regardless of scope. */
const FORBIDDEN_PATH_PREFIXES = [".github/", ".git/"]
const FORBIDDEN_PATHS = new Set([".github", ".git"])

/** File names we never let a patch create or modify. */
const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "composer.lock",
  "poetry.lock",
  "uv.lock",
  "cargo.lock",
  "go.sum",
  "gemfile.lock",
])

/** Secret-shaped strings a patch must not introduce (added lines only). */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, // GitHub tokens
  /\bsk-[A-Za-z0-9]{20,}\b/, // OpenAI-style
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWT
  /\b(?:api[_-]?key|api[_-]?secret|password|secret|token)\b\s*[:=]\s*["'][^"']{8,}["']/i,
]

interface ParsedFile {
  path: string
  isNew: boolean
  isDelete: boolean
  isBinary: boolean
  added: number
  removed: number
  addedLines: string[]
}

function normalizePath(raw: string): string {
  // Strip a/ b/ prefixes and normalize separators.
  let p = raw.trim()
  if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2)
  return p.replace(/\\/g, "/")
}

function baseName(p: string): string {
  const idx = p.lastIndexOf("/")
  return idx === -1 ? p : p.slice(idx + 1)
}

/**
 * Parse a unified diff into per-file records. Throws on anything that does not
 * look like a diff so the caller fails closed.
 */
function parseUnifiedDiff(diff: string): ParsedFile[] {
  const files: ParsedFile[] = []
  const lines = diff.split("\n")
  let current: ParsedFile | null = null
  let sawHeader = false

  for (const raw of lines) {
    if (raw.startsWith("diff --git ")) {
      sawHeader = true
      if (current) files.push(current)
      current = {
        path: "",
        isNew: false,
        isDelete: false,
        isBinary: false,
        added: 0,
        removed: 0,
        addedLines: [],
      }
      continue
    }
    if (!current) continue

    if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) {
      current.isBinary = true
      continue
    }
    if (raw.startsWith("new file mode")) {
      current.isNew = true
      continue
    }
    if (raw.startsWith("deleted file mode")) {
      current.isDelete = true
      continue
    }
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4).trim()
      current.path = target === "/dev/null" ? current.path : normalizePath(target)
      if (target === "/dev/null") current.isDelete = true
      continue
    }
    if (raw.startsWith("--- ")) {
      const source = raw.slice(4).trim()
      if (source === "/dev/null") current.isNew = true
      if (!current.path && source !== "/dev/null") current.path = normalizePath(source)
      continue
    }
    if (raw.startsWith("@@")) continue
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      current.added++
      current.addedLines.push(raw.slice(1))
      continue
    }
    if (raw.startsWith("-") && !raw.startsWith("---")) {
      current.removed++
      continue
    }
  }
  if (current) files.push(current)
  if (!sawHeader) throw new Error("not a unified diff")
  return files
}

/**
 * Validate a unified diff against the finding's scope and the plan's policy.
 *
 * @param diff        The unified diff text.
 * @param anchorFile  The single file the finding is anchored to (current-file scope).
 * @param implicatedFiles  The finding's full implicated file set (implicated-set scope).
 * @param policy      The plan's scope policy.
 */
export function validatePatchDiff(
  diff: string,
  anchorFile: string,
  implicatedFiles: readonly string[],
  policy: PatchScopePolicy
): DiffValidation {
  try {
    if (!diff || !diff.trim()) {
      return { ok: false, code: "EMPTY_DIFF", reason: "The patch is empty." }
    }

    let files: ParsedFile[]
    try {
      files = parseUnifiedDiff(diff)
    } catch {
      return { ok: false, code: "UNPARSEABLE", reason: "The patch is not a valid unified diff." }
    }
    if (files.length === 0) {
      return { ok: false, code: "EMPTY_DIFF", reason: "The patch contains no file changes." }
    }

    const anchor = normalizePath(anchorFile)
    const implicated = new Set(implicatedFiles.map(normalizePath))
    const allowed =
      policy.pathScope === "current-file" ? new Set([anchor]) : new Set([anchor, ...implicated])

    let linesTouched = 0
    const filesTouched: string[] = []

    for (const file of files) {
      const path = file.path
      if (!path) {
        return { ok: false, code: "UNPARSEABLE", reason: "A diff entry is missing its file path." }
      }
      filesTouched.push(path)
      linesTouched += file.added + file.removed

      if (file.isBinary) {
        return {
          ok: false,
          code: "BINARY_NOT_ALLOWED",
          reason: `Binary change to ${path} is not allowed.`,
        }
      }
      if (LOCKFILE_NAMES.has(baseName(path).toLowerCase())) {
        return {
          ok: false,
          code: "LOCKFILE_NOT_ALLOWED",
          reason: `Patch may not modify lockfile ${path}.`,
        }
      }
      if (FORBIDDEN_PATH_PREFIXES.some((p) => path.startsWith(p)) || FORBIDDEN_PATHS.has(path)) {
        return { ok: false, code: "FORBIDDEN_PATH", reason: `Patch may not touch ${path}.` }
      }
      if (!allowed.has(path)) {
        return {
          ok: false,
          code: file.isNew ? "NEW_FILE_OUT_OF_SCOPE" : "PATH_OUT_OF_SCOPE",
          reason: `${path} is outside the finding's scope for this plan.`,
        }
      }
      if (file.isDelete) {
        return { ok: false, code: "DELETE_NOT_ALLOWED", reason: `Patch may not delete ${path}.` }
      }
      // No new files at all under current-file scope.
      if (file.isNew && policy.pathScope === "current-file") {
        return {
          ok: false,
          code: "NEW_FILE_OUT_OF_SCOPE",
          reason: `Patch may not create ${path} on this plan.`,
        }
      }
      for (const line of file.addedLines) {
        for (const pattern of SECRET_PATTERNS) {
          if (pattern.test(line)) {
            return {
              ok: false,
              code: "SECRET_LIKE_CONTENT",
              reason: `Patch appears to introduce a credential or secret in ${path}.`,
            }
          }
        }
      }
    }

    if (linesTouched > policy.maxLinesTouched) {
      return {
        ok: false,
        code: "TOO_MANY_LINES",
        reason: `Patch touches ${linesTouched} lines; this plan allows at most ${policy.maxLinesTouched}.`,
      }
    }

    return { ok: true, filesTouched, linesTouched }
  } catch (error) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      reason: error instanceof Error ? error.message : "Patch validation failed.",
    }
  }
}
