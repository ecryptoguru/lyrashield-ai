import { invoke } from "@tauri-apps/api/core"
import type { AzureCredentials, ChatGptAuthStatus, LicenseStatus, RuntimeStatus } from "./types"

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

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  return invoke("get_runtime_status")
}

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
