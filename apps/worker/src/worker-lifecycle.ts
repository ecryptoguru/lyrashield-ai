export type WorkerRunTermination =
  { reason: "BULLMQ_RUN_RETURNED" } | { reason: "BULLMQ_RUN_FAILURE"; error: unknown }

export function observeWorkerRun(
  workerRun: Promise<void>,
  onUnexpectedStop: (termination: WorkerRunTermination) => void
): void {
  void workerRun.then(
    () => onUnexpectedStop({ reason: "BULLMQ_RUN_RETURNED" }),
    (error: unknown) => onUnexpectedStop({ reason: "BULLMQ_RUN_FAILURE", error })
  )
}
