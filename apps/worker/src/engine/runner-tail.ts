import { logger } from "@lyrashield/logger"
import { emitScanEvent } from "./runner-events"

/**
 * Bounded ring buffer of the last lines of an engine stream. Kept in memory
 * only; the content never enters operational logs. Size-bounded in both line
 * count and total characters so a chatty engine cannot grow the buffer
 * unboundedly.
 */
const ENGINE_TAIL_MAX_LINES = 40
const ENGINE_TAIL_MAX_CHARS = 8_000

export { ENGINE_TAIL_MAX_LINES, ENGINE_TAIL_MAX_CHARS }

interface EngineStreamTail {
  lines: string[]
  chars: number
  /** A trailing segment still waiting for its newline — held until the next
   * chunk or the final flush so a line split across chunk boundaries is
   * assembled instead of recorded as two partial lines. */
  pending: string
}

function createEngineStreamTail(): EngineStreamTail {
  return { lines: [], chars: 0, pending: "" }
}

export {
  createEngineStreamTail,
  appendEngineStreamTail,
  flushEngineStreamTail,
  redactEngineTailLine,
}

function appendEngineStreamTail(tail: EngineStreamTail, chunk: Buffer): void {
  const text = tail.pending + chunk.toString("utf8")
  const segments = text.split(/\r?\n/)
  // The final segment may be an incomplete line (no trailing newline yet) —
  // hold it back for the next chunk; flushEngineStreamTail emits it at the end.
  tail.pending = segments.pop() ?? ""
  for (const line of segments) {
    tail.lines.push(line)
    tail.chars += line.length + 1
    while (tail.lines.length > ENGINE_TAIL_MAX_LINES || tail.chars > ENGINE_TAIL_MAX_CHARS) {
      const dropped = tail.lines.shift()
      if (dropped === undefined) break
      tail.chars -= dropped.length + 1
    }
  }
}

/**
 * Emit any still-pending partial line (a stream that ended without a trailing
 * newline). Called once when the engine process closes, BEFORE the tail is
 * persisted. Idempotent: a second call has nothing pending.
 */
function flushEngineStreamTail(tail: EngineStreamTail): void {
  if (tail.pending === "") return
  const line = tail.pending
  tail.pending = ""
  tail.lines.push(line)
  tail.chars += line.length + 1
  while (tail.lines.length > ENGINE_TAIL_MAX_LINES || tail.chars > ENGINE_TAIL_MAX_CHARS) {
    const dropped = tail.lines.shift()
    if (dropped === undefined) break
    tail.chars -= dropped.length + 1
  }
}

/**
 * Redact secret-shaped content from a stream line before it is persisted to
 * evidence storage. Mirrors the fix-diff validator's credential heuristic:
 * a key/password/secret/token assignment with a substantial quoted or
 * unquoted value. Defensive only — evidence storage is encrypted at rest and
 * workspace-scoped, so this is belt-and-braces against forwarding tails into
 * a support conversation.
 */
const ENGINE_TAIL_SECRET_PATTERN =
  /\b(api[_-]?key|api[_-]?secret|password|passwd|secret|token|credential|authorization)\b(\s*[:=]\s*)(["']?)[A-Za-z0-9+/_=.\-:]{16,}\3|\b(bearer)\s+[A-Za-z0-9\-_.~+/=]{16,}/gi

function redactEngineTailLine(line: string): string {
  return line.replace(
    ENGINE_TAIL_SECRET_PATTERN,
    (match, keyName?: string, assignment?: string, quote?: string) => {
      // Alternative branch: a bare bearer token.
      if (/^bearer$/i.test(match.split(/\s+/)[0] ?? "")) {
        return "Bearer ***REDACTED***"
      }
      return `${keyName}${assignment}${quote}***REDACTED***${quote}`
    }
  )
}

/**
 * Persist the bounded, redacted stdout/stderr tail of a failed engine run to
 * encrypted evidence storage and reference it from a scan event. Runs inside
 * the scan job's workspace context. Best-effort: a failure here must never
 * mask the real engine result.
 */
export async function persistEngineStreamTail(
  scanId: string,
  exitCode: number,
  failureType: string | null,
  stdoutTail: EngineStreamTail,
  stderrTail: EngineStreamTail
): Promise<void> {
  try {
    const { getWorkspaceContext } = await import("@lyrashield/db")
    const { uploadEncryptedArtifact } = await import("@lyrashield/evidence-storage")
    const workspaceId = getWorkspaceContext()
    const stdout = stdoutTail.lines.map(redactEngineTailLine).join("\n").trim()
    const stderr = stderrTail.lines.map(redactEngineTailLine).join("\n").trim()
    if (!stdout && !stderr) return
    if (!workspaceId) {
      logger.warn("No workspace context; engine stream tail not persisted", { scanId })
      return
    }
    const content = [
      `Engine exited with code ${exitCode}${failureType ? ` (failure class: ${failureType})` : ""}.`,
      "",
      "--- stdout (last lines, redacted) ---",
      stdout || "(empty)",
      "",
      "--- stderr (last lines, redacted) ---",
      stderr || "(empty)",
    ].join("\n")
    const artifact = await uploadEncryptedArtifact({
      workspaceId,
      ownerId: scanId,
      type: "engine-stream-tail",
      content,
      artifactId: `engine-tail-${scanId}`,
      contentType: "text/plain; charset=utf-8",
    })
    await emitScanEvent(
      scanId,
      "engine_exit_tail",
      "warning",
      "Engine failure detail captured to encrypted evidence storage",
      {
        exitCode,
        ...(failureType ? { failureType } : {}),
        storageUri: artifact.storageUri,
        checksum: artifact.checksum,
        stdoutTailLines: stdoutTail.lines.length,
        stderrTailLines: stderrTail.lines.length,
      }
    )
  } catch (error) {
    logger.warn("Failed to persist engine stream tail (non-fatal)", {
      scanId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
