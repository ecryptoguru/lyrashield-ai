import type { ScanData, ScanPollData } from "./scan-detail-types"
import { asIsoString, asMetadata, mergeEvents } from "./scan-detail-utils"

export function projectScanPoll(
  updated: ScanPollData,
  current: ScanData,
  eventCursor: string | null
): ScanData {
  return {
    id: updated.id,
    workspaceId: updated.workspaceId,
    status: updated.status,
    goal: updated.goal,
    mode: updated.mode,
    triggerType: updated.triggerType,
    target: current.target,
    startedAt: asIsoString(updated.startedAt),
    endedAt: asIsoString(updated.endedAt),
    summary: updated.summary,
    errorCategory: updated.errorCategory,
    errorMessage: updated.errorMessage,
    createdAt: asIsoString(updated.createdAt)!,
    // The immutable plan is SSR-only; the poll never carries it.
    executionPlan: current.executionPlan,
    events: mergeEvents(
      current.events,
      (updated.events ?? []).map((event) => ({
        id: event.id,
        stage: event.stage,
        level: event.level,
        message: event.message,
        metadata: asMetadata(event.metadata),
        createdAt: asIsoString(event.createdAt)!,
      })),
      // A tail page is only merged when the server echoes that the
      // cursor sent on this very request was applied; anything else is a
      // full replacement.
      updated.eventsCursorApplied === eventCursor && eventCursor !== null
    ),
    capacity: updated.capacity ?? null,
    integrity: {
      ...current.integrity,
      manifestChecksum: updated.resultManifest?.checksum ?? null,
      // urlExecution comes from the server-rendered manifest detail;
      // the polling payload carries the checksum only.
      urlExecution: current.integrity.urlExecution,
      coverage: (updated.coverageReceipts ?? []).map((receipt) => ({
        scanner: receipt.scanner,
        controlId: receipt.controlId,
        status: receipt.status,
        reason: receipt.reason ?? null,
        subject: receipt.subject ?? null,
        metadata: asMetadata(receipt.metadata),
      })),
    },
    aiSecurity: current.aiSecurity,
  }
}
