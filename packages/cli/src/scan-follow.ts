import { waitForScan, type LyraShieldClient } from "@lyrashield/sdk"
import type { Output } from "./output.js"

export function parseWaitTimeout(value: unknown): number | null {
  if (value === undefined) return 1_800_000
  const seconds = Number(value)
  return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 86_400 ? seconds * 1_000 : null
}

/** Following a scan never submits or cancels it. */
export async function followScan(
  client: LyraShieldClient,
  scanId: string,
  workspaceId: string,
  timeoutMs: number,
  output: Output,
  operationId?: string
): Promise<number> {
  const controller = new AbortController()
  const onInterrupt = () => controller.abort()
  process.once("SIGINT", onInterrupt)
  try {
    const scan = await waitForScan(client, scanId, {
      workspaceId,
      timeoutMs,
      signal: controller.signal,
      onProgress: (current) => {
        process.stderr.write(`Scan ${scanId}: ${current.status}\n`)
      },
    })
    output.result(operationId ? { ...scan, operationId } : scan)
    return scan.status === "COMPLETED" ? 0 : 7
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null
    if (code === "REQUEST_ABORTED" || code === "WAIT_TIMEOUT") {
      const exitCode = code === "WAIT_TIMEOUT" ? 8 : 130
      output.error(
        `${error instanceof Error ? error.message : String(error)}; resume: lyrashield status ${scanId} --watch`,
        exitCode
      )
      return exitCode
    }
    throw error
  } finally {
    process.removeListener("SIGINT", onInterrupt)
  }
}
