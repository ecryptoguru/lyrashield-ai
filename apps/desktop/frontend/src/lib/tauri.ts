import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import type {
  AzureCredentials,
  AzureMetadata,
  ByokStatus,
  ChatGptAuthStatus,
  Finding,
  LicenseStatus,
  RuntimeStatus,
  ScanDetail,
  ScanEvent,
  ScanMode,
  ScanSummary,
  ScanTarget,
  SequencedEvent,
  SyncConnection,
  SyncResult,
  UpdateCheckResult,
} from "./types"

// License
export async function activateLicense(licenseKey: string, apiUrl?: string): Promise<LicenseStatus> {
  return invoke("activate_license", { licenseKey, apiUrl: apiUrl ?? null })
}
export async function verifyStoredLicense(apiUrl?: string): Promise<LicenseStatus> {
  return invoke("verify_stored_license", { apiUrl: apiUrl ?? null })
}
export async function getLicenseStatus(): Promise<LicenseStatus> {
  return invoke("get_license_status")
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
export async function loadAzureConfig(): Promise<AzureCredentials | null> {
  return invoke("load_azure_config")
}
export async function clearAzureConfig(): Promise<void> {
  return invoke("clear_azure_config")
}
export async function getByokMetadata(): Promise<AzureMetadata> {
  return invoke("get_byok_metadata")
}
export async function getByokStatus(): Promise<ByokStatus> {
  return invoke("get_byok_status")
}

// Scan — durable lifecycle, typed wrappers only (no raw invoke elsewhere)
export async function createScan(
  target: ScanTarget,
  mode: ScanMode,
  instruction?: string
): Promise<string> {
  return invoke("create_scan", { target, mode, instruction: instruction ?? null })
}
export async function startScan(
  target: ScanTarget,
  mode: ScanMode,
  instruction?: string
): Promise<string> {
  return invoke("start_scan", { target, mode, instruction: instruction ?? null })
}
export async function cancelScan(scanId: string): Promise<void> {
  return invoke("cancel_scan", { scanId })
}
export async function listScans(): Promise<ScanSummary[]> {
  return invoke("list_scans")
}
export async function getScanDetail(scanId: string): Promise<ScanDetail> {
  return invoke("get_scan_detail", { scanId })
}
export async function getScanEvents(scanId: string, fromSeq?: number): Promise<SequencedEvent[]> {
  return invoke("get_scan_events", { scanId, fromSeq: fromSeq ?? 0 })
}
export async function exportSarif(findings: Finding[], scanId: string): Promise<string> {
  return invoke("export_sarif", { findings, scanId })
}

// Scan events — replay-from-zero via getScanEvents + live listen
export async function onScanEvent(handler: (event: ScanEvent) => void): Promise<() => void> {
  const unlisteners: (() => void)[] = []
  const events = [
    "scan://started",
    "scan://progress",
    "scan://finding",
    "scan://completed",
    "scan://failed",
    "scan://cancelled",
  ]
  for (const evt of events) {
    const un = await listen<ScanEvent>(evt, (e) => handler(e.payload))
    unlisteners.push(un)
  }
  return () => unlisteners.forEach((u) => u())
}

// Updater
export async function checkUpdateEligibility(): Promise<UpdateCheckResult> {
  return invoke("check_update_eligibility")
}

// Sync
export async function connectWorkspace(
  apiUrl: string | undefined,
  workspaceId: string,
  licenseKey: string
): Promise<SyncConnection> {
  return invoke("connect_workspace", { apiUrl: apiUrl ?? null, workspaceId, licenseKey })
}
export async function syncFindings(
  apiUrl: string | undefined,
  connection: SyncConnection,
  findings: Finding[]
): Promise<SyncResult[]> {
  return invoke("sync_findings", { apiUrl: apiUrl ?? null, connection, findings })
}
export async function disconnectSync(): Promise<void> {
  return invoke("disconnect_sync")
}
