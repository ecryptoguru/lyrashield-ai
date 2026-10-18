/** Keep scanner observations separate from generic advice for an assessed control. */
export function partitionControlSignals<T extends { state: string; remediation: string }>(
  signals: T[]
) {
  return {
    findings: signals.filter((signal) => signal.state === "DETECTED"),
    coverage: signals.filter((signal) => signal.state === "INCONCLUSIVE"),
    guidance: [
      ...new Set(
        signals
          .filter((signal) => signal.state === "NO_FINDING")
          .map((signal) => signal.remediation)
      ),
    ],
  }
}
