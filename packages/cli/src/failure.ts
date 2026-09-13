/** Maps an uncaught command error to the CLI's message and exit code. */
export function describeCliFailure(err: unknown): { message: string; exitCode: number } {
  const status =
    err && typeof err === "object" && "status" in err && typeof err.status === "number"
      ? err.status
      : null
  let exitCode = 4
  if (status === 401 || status === 403) exitCode = 3
  else if (status === 429) exitCode = 5
  else if (status === 402) exitCode = 6
  // 402 means the plan or agent-minute balance refused the action — point at
  // Billing instead of echoing the raw server message.
  const message =
    status === 402
      ? "Plan or agent-minute balance does not allow this. Open Billing."
      : err instanceof Error
        ? err.message
        : String(err)
  return { message, exitCode }
}
