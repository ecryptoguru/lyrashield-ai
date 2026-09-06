/** Reconstruct elapsed wall time once, then use a monotonic clock within an attempt. */
export function scanElapsedClock(
  startedAt: Date | null | undefined,
  wallNow = Date.now(),
  monotonicNow: () => number = () => performance.now()
): () => number {
  const startedMs = startedAt?.getTime()
  const priorElapsed =
    typeof startedMs === "number" && Number.isFinite(startedMs)
      ? Math.max(0, wallNow - startedMs)
      : 0
  const origin = monotonicNow()
  return () => priorElapsed + Math.max(0, monotonicNow() - origin)
}

/** Detach only cleanup I/O; never use this to abandon a money/evidence transaction. */
export async function boundedCleanup(work: Promise<void>, timeoutMs = 30_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Workspace cleanup exceeded its grace period")),
          timeoutMs
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
