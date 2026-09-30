import type { ScanStatus } from "@lyrashield/db"
import type { LaunchAssuranceDeps, StepRecord } from "./verify-launch-assurance-contract"

export function boundedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 200)
}
export function assertSelectedScanQueueIsolation(
  scanId: string,
  scanStatus: ScanStatus,
  scanJobs: Array<{
    id: string
    state: "waiting" | "active" | "delayed" | "prioritized"
  }>
): void {
  if (scanJobs.length === 0) {
    throw new Error("selected scan has no processable queue job; refusing failure injection")
  }
  if (scanJobs.length !== 1 || scanJobs[0]?.id !== scanId) {
    throw new Error("unexpected or ambiguous scan queue work exists; refusing failure injection")
  }
  const state = scanJobs[0].state
  const stateMatchesStatus =
    scanStatus === "QUEUED"
      ? state === "waiting" || state === "delayed" || state === "prioritized"
      : state === "active"
  if (!stateMatchesStatus) {
    throw new Error(
      `selected scan queue state ${state} does not match database status ${scanStatus}; refusing failure injection`
    )
  }
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`step timed out after ${timeoutMs}ms`)), timeoutMs)
    }),
  ])
}

export async function runStep(
  name: string,
  fn: () => Promise<string | undefined>,
  deps: LaunchAssuranceDeps,
  timeoutMs: number
): Promise<StepRecord> {
  const start = deps.now().getTime()
  try {
    const reason = await withTimeout(fn(), timeoutMs)
    return { name, status: "passed", reason, durationMs: deps.now().getTime() - start }
  } catch (error) {
    return {
      name,
      status: "failed",
      reason: boundedReason(error),
      durationMs: deps.now().getTime() - start,
    }
  }
}

export async function readEgressPinArgs(
  pinFile: string,
  readFileFn: (path: string) => Promise<string>
): Promise<string[]> {
  const content = await readFileFn(pinFile)
  const args: string[] = []
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim()
    if (!line) continue
    const [host, address, port, extra] = line.split(/\s+/)
    if (!host || !address || !port || extra) {
      throw new Error(`Invalid egress pin entry: ${line}`)
    }
    args.push("--add-host", `${host}:${address}`)
  }
  return args
}
