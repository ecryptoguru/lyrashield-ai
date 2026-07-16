import type { ScanStatus } from "./generated/prisma"

const VALID_TRANSITIONS: Record<ScanStatus, ScanStatus[]> = {
  QUEUED: ["PREFLIGHT", "CANCELLED", "FAILED"],
  PREFLIGHT: ["PREFLIGHT", "RUNNING", "REQUIRES_APPROVAL", "FAILED", "CANCELLED"],
  RUNNING: ["PREFLIGHT", "VERIFYING", "FAILED", "CANCELLED", "STOPPED_BUDGET", "TIMED_OUT"],
  VERIFYING: ["PREFLIGHT", "COMPLETED", "FAILED", "STOPPED_BUDGET"],
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
