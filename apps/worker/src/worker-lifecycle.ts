type WorkerRunTermination =
  { reason: "BULLMQ_RUN_RETURNED" } | { reason: "BULLMQ_RUN_FAILURE"; error: unknown }

/**
 * All BullMQ workers in this process share the Prisma pool. Count every
 * concurrently active processor and keep one connection available for scan
 * finalization's nested evidence transactions.
 */
export function assertWorkerDbPoolCapacity(
  scanConcurrency: number,
  dbPoolMax: number,
  auxiliaryWorkerConcurrency = 0
): void {
  const totalWorkerConcurrency = scanConcurrency + auxiliaryWorkerConcurrency
  if (totalWorkerConcurrency >= dbPoolMax) {
    throw new Error(
      `Total worker concurrency (${scanConcurrency} scan + ${auxiliaryWorkerConcurrency} auxiliary = ${totalWorkerConcurrency}) must be lower than LYRASHIELD_DB_POOL_MAX (${dbPoolMax}) to reserve a connection for nested scan finalization.`
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
