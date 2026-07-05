import type { ScanStatus } from "./generated/prisma"

const VALID_TRANSITIONS: Record<ScanStatus, ScanStatus[]> = {
  QUEUED: ["PREFLIGHT", "CANCELLED", "FAILED"],
  PREFLIGHT: ["RUNNING", "REQUIRES_APPROVAL", "FAILED", "CANCELLED"],
  RUNNING: ["VERIFYING", "FAILED", "CANCELLED", "STOPPED_BUDGET", "TIMED_OUT"],
  VERIFYING: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  REQUIRES_APPROVAL: ["RUNNING", "CANCELLED"],
  STOPPED_BUDGET: [],
  TIMED_OUT: [],
}

export function isValidTransition(from: ScanStatus, to: ScanStatus): boolean {
  const allowed = VALID_TRANSITIONS[from]
  return allowed ? allowed.includes(to) : false
}

export { VALID_TRANSITIONS }
