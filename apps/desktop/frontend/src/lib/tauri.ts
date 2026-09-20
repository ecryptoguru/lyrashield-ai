import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import type {
  AzureMetadata,
  ByokStatus,
  ChatGptAuthStatus,
  CloudTarget,
  Finding,
  LicenseStatus,
  RuntimeStatus,
  ScanEvent,
  ScanDetail,
  ScanMode,
  ScanSummary,
  ScanTarget,
  ScanWorkflow,
  SequencedEvent,
  SyncConnection,
  SyncResult,
  UpdateCheckResult,
  UpdateProgress,
} from "./types"

// Rust scan structs use snake_case on the existing IPC/storage wire. Keep that
// contract here so components and cloud DTOs consistently use camelCase.
type NativeFinding = Omit<
  Finding,
  | "filePath"
  | "lineNumber"
  | "detectedAt"
  | "verificationState"
  | "evidencePending"
  | "confidenceRationale"
  | "fixVerification"
  | "httpExchangeIds"
> & {
  file_path: string | null
  line_number: number | null
  detected_at: string
  verification_state: string
  evidence_pending: boolean
  confidence_rationale: string | null
  fix_verification: string | null
  http_exchange_ids: string[]
}
type NativeScanSummary = Omit<
  ScanSummary,
  | "scanId"
  | "startedAt"
  | "completedAt"
  | "findingCount"
  | "contractVersion"
  | "diffBase"
  | "diffHead"
> & {
  scan_id: string
  started_at: string
  completed_at: string | null
  finding_count: number
  contract_version: string | null
  diff_base: string | null
  diff_head: string | null
}
type NativeScanEvent =
  | { type: "started" | "cancelled"; scan_id: string }
  | { type: "progress"; scan_id: string; line: string; stream: string }
  | { type: "finding"; scan_id: string; finding: NativeFinding }
  | { type: "completed"; scan_id: string; exit_code: number; finding_count: number }
  | { type: "failed" | "error"; scan_id: string; error: string }

function fromNativeFinding({
  file_path,
  line_number,
  detected_at,
  verification_state,
  evidence_pending,
  confidence_rationale,
  fix_verification,
  http_exchange_ids,
  ...finding
}: NativeFinding): Finding {
  return {
    ...finding,
    filePath: file_path,
    lineNumber: line_number,
    detectedAt: detected_at,
    verificationState: verification_state,
    evidencePending: evidence_pending,
    confidenceRationale: confidence_rationale,
    fixVerification: fix_verification,
    httpExchangeIds: http_exchange_ids,
  }
}
function toNativeFinding({
  filePath,
  lineNumber,
  detectedAt,
  verificationState,
  evidencePending,
  confidenceRationale,
  fixVerification,
  httpExchangeIds,
  ...finding
}: Finding): NativeFinding {
  return {
    ...finding,
    file_path: filePath,
    line_number: lineNumber,
    detected_at: detectedAt,
    verification_state: verificationState,
    evidence_pending: evidencePending,
    confidence_rationale: confidenceRationale,
    fix_verification: fixVerification,
    http_exchange_ids: httpExchangeIds,
  }
}
function fromNativeSummary({
  scan_id,
  started_at,
  completed_at,
  finding_count,
  contract_version,
  diff_base,
  diff_head,
  ...scan
}: NativeScanSummary): ScanSummary {
  return {
    ...scan,
    scanId: scan_id,
    startedAt: started_at,
    completedAt: completed_at,
    findingCount: finding_count,
    contractVersion: contract_version,
    diffBase: diff_base,
    diffHead: diff_head,
  }
}
function fromNativeEvent(event: NativeScanEvent): ScanEvent {
  const scanId = event.scan_id
  switch (event.type) {
    case "finding":
      return { type: event.type, scanId, finding: fromNativeFinding(event.finding) }
    case "completed":
      return {
        type: event.type,
        scanId,
        exitCode: event.exit_code,
        findingCount: event.finding_count,
      }
    case "progress":
      return { type: event.type, scanId, line: event.line, stream: event.stream }
    case "failed":
    case "error":
      return { type: event.type, scanId, error: event.error }
    default:
      return { type: event.type, scanId }
  }
}

// License
export async function activateLicense(licenseKey: string, apiUrl?: string): Promise<LicenseStatus> {
  return invoke("activate_license", { licenseKey, apiUrl: apiUrl ?? null })
}
export async function startupRevalidateLicense(): Promise<LicenseStatus> {
  return invoke("startup_revalidate_license")
}
export async function clearLicense(): Promise<void> {
  return invoke("clear_license")
}

// Runtime
export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  return invoke("get_runtime_status")
}

// BYOK — typed wrappers, never expose raw secrets in logs
export async function startChatGptLogin(): Promise<void> {
  return invoke("start_chatgpt_login")
}
export async function checkChatGptStatus(): Promise<ChatGptAuthStatus> {
  return invoke("check_chatgpt_status")
}
export async function logoutChatGpt(): Promise<void> {
  return invoke("logout_chatgpt")
}
export async function saveAzureConfig(apiKey: string, endpoint: string): Promise<void> {
  return invoke("save_azure_config", { apiKey, endpoint })
}
export async function getByokMetadata(): Promise<AzureMetadata> {
  return invoke("get_byok_metadata")
}
export async function getByokStatus(): Promise<ByokStatus> {
  return invoke("get_byok_status")
}

// Scan — durable lifecycle, typed wrappers only (no raw invoke elsewhere)
export async function startScan(
  target: ScanTarget,
  mode: ScanMode,
  workflow: ScanWorkflow,
  diffBase: string | undefined,
  diffHead: string | undefined,
  instruction: string | undefined,
  maxBudgetUsd: number
): Promise<string> {
  return invoke("start_scan", {
    target,
    mode,
    workflow,
    diffBase: diffBase ?? null,
    diffHead: diffHead ?? null,
    instruction: instruction ?? null,
    maxBudgetUsd,
  })
}

/**
 * Submit a recorded scan to LyraShield Cloud — the hosted, evidence-producing
 * path whose server-owned execution plan binds workflow/scope/refs. Explicit
 * user action only; the local engine is never a substitute for it.
 */
export async function startCloudScan(
  apiUrl: string | undefined,
  workspaceId: string,
  targetId: string,
  mode: ScanMode,
  workflow: ScanWorkflow,
  baseRef: string | undefined,
  headRef: string | undefined
): Promise<string> {
  return invoke("start_cloud_scan", {
    apiUrl: apiUrl ?? null,
    workspaceId,
    targetId,
    mode,
    workflow,
    baseRef: baseRef ?? null,
    headRef: headRef ?? null,
  })
}

type NativeCloudTarget = Omit<CloudTarget, "targetType"> & { target_type: string }

/**
 * Connected LyraShield Cloud targets for recorded scan submission. Uses the
 * keychain-held Cloud Sync key — the key itself never reaches the webview.
 */
export async function listCloudTargets(
  apiUrl: string | undefined,
  workspaceId: string
): Promise<CloudTarget[]> {
  const rows = await invoke<NativeCloudTarget[]>("list_cloud_targets", {
    apiUrl: apiUrl ?? null,
    workspaceId,
  })
  return rows.map(({ target_type, ...t }) => ({ ...t, targetType: target_type }))
}
export async function cancelScan(scanId: string): Promise<void> {
  return invoke("cancel_scan", { scanId })
}
export async function listScans(): Promise<ScanSummary[]> {
  return (await invoke<NativeScanSummary[]>("list_scans")).map(fromNativeSummary)
}
export async function getScanDetail(scanId: string): Promise<ScanDetail> {
  const { findings, ...summary } = await invoke<NativeScanSummary & { findings: NativeFinding[] }>(
    "get_scan_detail",
    { scanId }
  )
  return { ...fromNativeSummary(summary), findings: findings.map(fromNativeFinding) }
}
export async function getScanEvents(scanId: string, fromSeq?: number): Promise<SequencedEvent[]> {
  const events = await invoke<{ seq: number; event: NativeScanEvent }[]>("get_scan_events", {
    scanId,
    fromSeq: fromSeq ?? 0,
  })
  return events.map(({ seq, event }) => ({ seq, event: fromNativeEvent(event) }))
}
export async function exportSarif(findings: Finding[], scanId: string): Promise<string> {
  return invoke("export_sarif", { findings: findings.map(toNativeFinding), scanId })
}

// Scan events — replay-from-zero via getScanEvents + live listen
export async function onScanEvent(handler: (event: ScanEvent) => void): Promise<() => void> {
  const unlisteners: (() => void)[] = []
  const cleanup = () => unlisteners.splice(0).forEach((unlisten) => unlisten())
  const events = [
    "scan://started",
    "scan://progress",
    "scan://finding",
    "scan://completed",
    "scan://failed",
    "scan://cancelled",
    "scan://error",
  ]
  try {
    for (const evt of events) {
      const un = await listen<NativeScanEvent>(evt, (e) => handler(fromNativeEvent(e.payload)))
      unlisteners.push(un)
    }
  } catch (error) {
    cleanup()
    throw error
  }
  return cleanup
}

// Updater
export async function checkUpdateEligibility(): Promise<UpdateCheckResult> {
  return invoke("check_update_eligibility")
}
export async function installUpdate(expectedVersion: string): Promise<void> {
  return invoke("install_update", { expectedVersion })
}
export async function onUpdateProgress(
  handler: (progress: UpdateProgress) => void
): Promise<() => void> {
  return listen<UpdateProgress>("updater://progress", (event) => handler(event.payload))
}

// Sync — raw key never in React; Rust keychain holds it
export async function connectWorkspace(
  apiUrl: string | undefined,
  workspaceId: string
): Promise<SyncConnection> {
  return invoke("connect_workspace", { apiUrl: apiUrl ?? null, workspaceId })
}
export async function saveSyncApiKey(apiKey: string): Promise<void> {
  return invoke("save_sync_api_key", { apiKey })
}
export async function hasSyncApiKey(): Promise<boolean> {
  return invoke("has_sync_api_key")
}
export async function syncFindings(
  apiUrl: string | undefined,
  workspaceId: string,
  findings: Finding[]
): Promise<SyncResult[]> {
  const results = await invoke<
    (
      | { status: "success"; synced_count: number; new_seq: number; new_cursor: string }
      | { status: "cursor_rewind"; server_seq: number; message: string }
      | { status: "entitlement_missing" | "error"; message: string }
    )[]
  >("sync_findings", {
    apiUrl: apiUrl ?? null,
    workspaceId,
    findings: findings.map(toNativeFinding),
  })
  return results.map((result) => {
    if (result.status === "success")
      return {
        status: result.status,
        syncedCount: result.synced_count,
        newSeq: result.new_seq,
        newCursor: result.new_cursor,
      }
    if (result.status === "cursor_rewind")
      return { status: result.status, serverSeq: result.server_seq, message: result.message }
    return result
  })
}
export async function getSyncState(): Promise<SyncConnection | null> {
  return invoke("get_sync_state")
}
export async function disconnectSync(): Promise<void> {
  return invoke("disconnect_sync")
}
