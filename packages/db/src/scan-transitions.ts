import type { ScanStatus } from "./generated/prisma"

const VALID_TRANSITIONS: Record<ScanStatus, ScanStatus[]> = {
  QUEUED: ["PREFLIGHT", "CANCELLED", "FAILED"],
  PREFLIGHT: ["PREFLIGHT", "RUNNING", "REQUIRES_APPROVAL", "FAILED", "CANCELLED"],
  RUNNING: ["PREFLIGHT", "VERIFYING", "FAILED", "CANCELLED", "STOPPED_BUDGET", "TIMED_OUT"],
  VERIFYING: ["PREFLIGHT", "COMPLETED", "PARTIAL", "FAILED", "CANCELLED", "STOPPED_BUDGET"],
  COMPLETED: [],
  PARTIAL: [],
  FAILED: [],
  CANCELLED: [],
  REQUIRES_APPROVAL: ["RUNNING", "CANCELLED"],
  STOPPED_BUDGET: [],
  TIMED_OUT: [],
}

const TERMINAL_SCAN_STATUSES = new Set<ScanStatus>([
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
  "STOPPED_BUDGET",
  "TIMED_OUT",
])

export function isValidTransition(from: ScanStatus, to: ScanStatus): boolean {
  const allowed = VALID_TRANSITIONS[from]
  return allowed ? allowed.includes(to) : false
}

export function isTerminalScanStatus(status: ScanStatus): boolean {
  return TERMINAL_SCAN_STATUSES.has(status)
}

export { TERMINAL_SCAN_STATUSES, VALID_TRANSITIONS }
