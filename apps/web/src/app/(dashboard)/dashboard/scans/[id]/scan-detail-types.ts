export interface ScanEvent {
  id: string
  stage: string
  level: string
  message: string
  metadata?: Record<string, unknown> | null
  createdAt: string
}

export interface ScanData {
  id: string
  workspaceId: string
  status: string
  goal: string
  mode: string
  triggerType: string
  startedAt: string | null
  endedAt: string | null
  summary: string | null
  errorCategory: string | null
  errorMessage: string | null
  createdAt: string
  /** The scan's place in the run queue while QUEUED (1-based + total waiting). */
  queuePosition?: { position: number; waiting: number } | null
  target: {
    id: string
    name: string
    type: string
    url: string | null
    repoFullName: string | null
  } | null
  events: ScanEvent[]
  integrity: {
    manifestChecksum: string | null
    urlExecution?: Record<string, unknown> | null
    coverage: Array<{
      scanner: string
      controlId: string
      status: string
      reason: string | null
      subject: string | null
      metadata: Record<string, unknown> | null
    }>
    standards?: Array<{
      standardId: string
      name: string
      version: string
      badge?: string
      evaluated: number
      requiresAttestation: number
      notEvaluated: number
      violationSignals: number
      categories: Array<{
        id: string
        title: string
        state: "evaluated" | "requires-attestation" | "not-evaluated"
        violationSignals: number
        limited?: boolean
        attestable?: boolean
      }>
    }>
  }
  aiSecurity: {
    score: number | null
    methodology: string
    assessedCount: number
    totalControls: number
    evidenceQuality: Record<string, number> | null
    reason: string | null
    ai03: unknown
    triage: unknown
    computedAt: string
  } | null
}

export interface ScanPollData {
  id: string
  workspaceId: string
  status: string
  goal: string
  mode: string
  triggerType: string
  startedAt: string | Date | null
  endedAt: string | Date | null
  summary: string | null
  errorCategory: string | null
  errorMessage: string | null
  llmRequestCount?: number | null
  llmInputTokens?: number | null
  llmCachedInputTokens?: number | null
  llmOutputTokens?: number | null
  createdAt: string | Date
  events?: Array<
    Omit<ScanEvent, "metadata" | "createdAt"> & { metadata?: unknown; createdAt: string | Date }
  >
  /** Echoed when an incremental event window was applied to this response. */
  eventsCursorApplied?: string
  resultManifest?: { checksum?: string | null } | null
  coverageReceipts?: Array<{
    scanner: string
    controlId: string
    status: string
    reason?: string | null
    subject?: string | null
    metadata?: unknown
  }>
}

export interface FindingItem {
  id: string
  title: string
  severity: string
  status: string
  cwe: string | null
  cvssScore: number | null
  summary: string | null
  verified: boolean
  verificationStatus: string
  verificationMethod: string | null
  verificationReason: string | null
  createdAt: string
}

export interface CleanResultScorecard {
  targetId: string
  grade: string
  canPublish: boolean
  existingShare?: {
    id: string
    slug: string
    url: string
    resolvedFindings: number
    views: number
    shareHandoffs: number
    referredSignups: number
  }
}
