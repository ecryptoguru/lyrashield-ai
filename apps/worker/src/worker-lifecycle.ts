type WorkerRunTermination =
  { reason: "BULLMQ_RUN_RETURNED" } | { reason: "BULLMQ_RUN_FAILURE"; error: unknown }

/**
 * Finalization holds one connection while it runs nested evidence transactions.
 * Keep one connection available so concurrent finalizers cannot all wait on
 * connections held by their own outer transactions.
 */
export function assertWorkerDbPoolCapacity(workerConcurrency: number, dbPoolMax: number): void {
  if (workerConcurrency >= dbPoolMax) {
    throw new Error(
      `LYRASHIELD_WORKER_CONCURRENCY (${workerConcurrency}) must be lower than LYRASHIELD_DB_POOL_MAX (${dbPoolMax}) to reserve a connection for nested scan finalization.`
    )
  }
}

export function observeWorkerRun(
  workerRun: Promise<void>,
  onUnexpectedStop: (termination: WorkerRunTermination) => void
): void {
  void workerRun.then(
    () => onUnexpectedStop({ reason: "BULLMQ_RUN_RETURNED" }),
    (error: unknown) => onUnexpectedStop({ reason: "BULLMQ_RUN_FAILURE", error })
  )
}
