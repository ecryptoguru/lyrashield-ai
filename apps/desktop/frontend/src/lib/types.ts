export type LicenseSku =
  | "individual_launch"
  | "individual_regular"
  | "team_perpetual"
  | "team_subscription"
  | "renewal"
  | "sync_addon"

export interface LicenseFile {
  sku: LicenseSku
  seatCount: number
  machineIds: string[]
  updateEligibleUntil: string
  perpetualFallbackBuild: string | null
  signingKeyId: string
  signature: string
  issuedAt: string
}

export type LicenseStatus =
  | { state: "active"; sku: LicenseSku; seatCount: number; machineCount: number; updateEligibleUntil: string; updateEligible: boolean; perpetualFallbackBuild: string | null }
  | { state: "expired_eligibility"; updateEligibleUntil: string; perpetualFallbackBuild: string | null }
  | { state: "revoked" }
  | { state: "none" }

export interface EngineInfo {
  found: boolean
  path: string | null
  version: string | null
}

export interface DockerInfo {
  found: boolean
  running: boolean
  version: string | null
}

export interface RuntimeStatus {
  engine: EngineInfo
  docker: DockerInfo
}

export type ChatGptAuthStatus =
  | { status: "signed_in" }
  | { status: "signed_out" }
  | { status: "error"; message: string }

export interface AzureCredentials {
  apiKey: string
  endpoint: string
}
