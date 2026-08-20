import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import type {
  AzureCredentials,
  ChatGptAuthStatus,
  Finding,
  LicenseStatus,
  RuntimeStatus,
  ScanEvent,
  ScanMode,
  ScanTarget,
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

// BYOK
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

// Scan
export async function startScan(
  target: ScanTarget,
  mode: ScanMode,
  instruction?: string
): Promise<string> {
  return invoke("start_scan", { target, mode, instruction: instruction ?? null })
}
export async function exportSarif(findings: Finding[], scanId: string): Promise<string> {
  return invoke("export_sarif", { findings, scanId })
}

// Scan events
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
