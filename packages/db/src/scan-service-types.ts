import type { DeterminismMode, ScanWorkflow } from "@lyrashield/types"

export interface CreateScanParams {
  workspaceId: string
  targetId: string
  goal: string
  mode?: string
  policyId?: string
  createdById: string
  triggerType?: string
  determinismMode?: DeterminismMode
  /**
   * Optional workflow input (defaults to REVIEW_TARGET). The server constructs
   * and persists the authoritative ScanExecutionPlan snapshot — callers supply
   * workflow intent and already-resolved provenance only, never plan fields,
   * limits, or capabilities.
   */
  workflow?: ScanWorkflow
  /**
   * Immutable git object IDs resolved through the authorized source
   * integration BEFORE the admission lock is taken. Required for
   * REVIEW_CHANGES (revision + baseRevision + mergeBaseRevision).
   */
  source?: {
    revision: string
    baseRevision?: string
    mergeBaseRevision?: string
  }
  attachmentIds?: string[]
  authorizationRef?: string
  /**
   * The delegated OAuth connection grant that authorized this scan, when the
   * caller authenticated through a hosted MCP/agent credential. Persisted on
   * the scan row so the async execution boundary (verifyScanAdmission) can
   * re-verify the exact grant — the synchronous request-time allow is never
   * inherited blindly by the queued job.
   */
  delegatedConnection?: { connectionId: string; authorizationVersion: number }
}
