import { z } from "zod"

export interface ScanSubmissionScope {
  principalId: string
  workspaceId: string
  surface: "onboarding" | "dashboard"
}

export interface ScanSubmissionStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const scanOperationStatusSchema = z.object({
  operationId: z.string().min(1),
  status: z.enum(["PENDING", "EXECUTING", "COMPLETED", "FAILED", "CONFLICT"]),
  reasonCode: z.string().nullable(),
  resultLocation: z.string().nullable(),
  recovery: z.enum(["wait", "poll", "retry_new_key", "none"]),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type ScanOperationStatus = z.infer<typeof scanOperationStatusSchema>

const pendingSubmissionSchema = z.object({
  version: z.literal(1),
  principalId: z.string().min(1),
  workspaceId: z.string().min(1),
  surface: z.enum(["onboarding", "dashboard"]),
  requestIdentity: z.string().min(1).max(50_000),
  idempotencyKey: z.string().uuid(),
  state: z.enum(["pending", "accepted"]),
  scanId: z.string().min(1).optional(),
  operationId: z.string().min(1).optional(),
})

export type PendingScanSubmission = z.infer<typeof pendingSubmissionSchema>

function getSessionStorage(): ScanSubmissionStorage {
  try {
    if (typeof window === "undefined") throw new Error()
    return window.sessionStorage
  } catch {
    throw new Error("Browser session storage is unavailable; this scan was not submitted.")
  }
}

function storageKey(scope: ScanSubmissionScope): string {
  return [
    "lyrashield",
    "scan-submission",
    "v1",
    encodeURIComponent(scope.principalId),
    encodeURIComponent(scope.workspaceId),
    scope.surface,
  ].join(":")
}

function normalizeForIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForIdentity)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeForIdentity(entry)])
    )
  }
  return value
}

export function scanRequestIdentity(payload: unknown): string {
  return JSON.stringify(normalizeForIdentity(payload))
}

export function readPendingScanSubmission(
  scope: ScanSubmissionScope,
  storage: ScanSubmissionStorage = getSessionStorage()
): PendingScanSubmission | null {
  const raw = storage.getItem(storageKey(scope))
  if (raw === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(
      "Saved scan recovery data is unreadable; inspect it before starting another scan."
    )
  }
  const result = pendingSubmissionSchema.safeParse(parsed)
  if (
    !result.success ||
    result.data.principalId !== scope.principalId ||
    result.data.workspaceId !== scope.workspaceId ||
    result.data.surface !== scope.surface ||
    (result.data.state === "accepted" && !result.data.scanId)
  ) {
    throw new Error("Saved scan recovery data is invalid; inspect it before starting another scan.")
  }
  return result.data
}

export function beginScanSubmission(
  scope: ScanSubmissionScope,
  payload: unknown,
  storage: ScanSubmissionStorage = getSessionStorage(),
  createIdempotencyKey: () => string = () => crypto.randomUUID()
):
  | { kind: "created" | "existing"; submission: PendingScanSubmission }
  | {
      kind: "conflict"
      submission: PendingScanSubmission
    } {
  const requestIdentity = scanRequestIdentity(payload)
  const existing = readPendingScanSubmission(scope, storage)
  // Accepted scans are already retained by the caller. Only a pending request
  // needs its original idempotency key for safe recovery after a lost response.
  if (existing?.state === "pending") {
    return existing.requestIdentity === requestIdentity
      ? { kind: "existing", submission: existing }
      : { kind: "conflict", submission: existing }
  }

  const submission = pendingSubmissionSchema.parse({
    version: 1,
    ...scope,
    requestIdentity,
    idempotencyKey: createIdempotencyKey(),
    state: "pending",
  })
  storage.setItem(storageKey(scope), JSON.stringify(submission))
  return { kind: "created", submission }
}

function updatePendingSubmission(
  scope: ScanSubmissionScope,
  idempotencyKey: string,
  update: (submission: PendingScanSubmission) => PendingScanSubmission,
  storage: ScanSubmissionStorage
): PendingScanSubmission | null {
  const current = readPendingScanSubmission(scope, storage)
  if (!current || current.idempotencyKey !== idempotencyKey) return null
  const next = pendingSubmissionSchema.parse(update(current))
  storage.setItem(storageKey(scope), JSON.stringify(next))
  return next
}

export function recordScanOperation(
  scope: ScanSubmissionScope,
  idempotencyKey: string,
  operationId: string,
  storage: ScanSubmissionStorage = getSessionStorage()
): PendingScanSubmission | null {
  return updatePendingSubmission(
    scope,
    idempotencyKey,
    (submission) => ({ ...submission, operationId }),
    storage
  )
}

export function recordAcceptedScan(
  scope: ScanSubmissionScope,
  idempotencyKey: string,
  scanId: string,
  operationId?: string,
  storage: ScanSubmissionStorage = getSessionStorage()
): PendingScanSubmission | null {
  return updatePendingSubmission(
    scope,
    idempotencyKey,
    (submission) => ({
      ...submission,
      state: "accepted",
      scanId,
      ...(operationId ? { operationId } : {}),
    }),
    storage
  )
}

export function clearPendingScanSubmission(
  scope: ScanSubmissionScope,
  expectedIdempotencyKey?: string,
  storage: ScanSubmissionStorage = getSessionStorage()
): boolean {
  if (expectedIdempotencyKey) {
    const current = readPendingScanSubmission(scope, storage)
    if (!current || current.idempotencyKey !== expectedIdempotencyKey) return false
  }
  storage.removeItem(storageKey(scope))
  return true
}

export function operationIdFromErrorDetails(details: unknown): string | null {
  const parsed = z.object({ operationId: z.string().min(1) }).safeParse(details)
  return parsed.success ? parsed.data.operationId : null
}

export async function runScanSubmission<T>(
  lock: { current: boolean },
  submit: () => Promise<T>
): Promise<T | undefined> {
  if (lock.current) return undefined
  lock.current = true
  try {
    return await submit()
  } finally {
    lock.current = false
  }
}
