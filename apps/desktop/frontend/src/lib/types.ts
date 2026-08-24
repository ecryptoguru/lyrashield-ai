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
  | {
      state: "active"
      sku: LicenseSku
      seatCount: number
      machineCount: number
      updateEligibleUntil: string
      updateEligible: boolean
      perpetualFallbackBuild: string | null
      offlineGraceRemainingSeconds: number | null
    }
  | {
      state: "expired_eligibility"
      updateEligibleUntil: string
      perpetualFallbackBuild: string | null
      offlineGraceRemainingSeconds: number | null
    }
  | { state: "offline_grace_expired" }
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
  { status: "signed_in" } | { status: "signed_out" } | { status: "error"; message: string }

export interface AzureMetadata {
  configured: boolean
  endpoint: string | null
  keyMasked: string | null
}

export interface ByokStatus {
  chatgpt: ChatGptAuthStatus
  azure: AzureMetadata
}

export interface SequencedEvent {
  seq: number
  event: ScanEvent
}

export type ScanMode = "safe" | "quick" | "standard" | "deep" | "custom" | "url"

export type ScanTarget =
  | { type: "repo"; path: string; branch: string | null }
  | { type: "url"; url: string }
  | { type: "local_path"; path: string }

export interface Finding {
  id: string
  severity: string
  title: string
  description: string | null
  filePath: string | null
  lineNumber: number | null
  status: string
  verified: boolean
  detectedAt: string
}

export type ScanStatus = "pending" | "running" | "completed" | "failed" | "cancelled"

export interface ScanSummary {
  scanId: string
  target: string
  mode: ScanMode
  status: ScanStatus
  startedAt: string
  completedAt: string | null
  findingCount: number
}

export interface ScanDetail {
  scanId: string
  target: string
  mode: ScanMode
  status: ScanStatus
  startedAt: string
  completedAt: string | null
  findingCount: number
  findings: Finding[]
}

export type ScanEvent =
  | { type: "started"; scanId: string }
  | { type: "progress"; scanId: string; line: string; stream: string }
  | { type: "finding"; scanId: string; finding: Finding }
  | { type: "completed"; scanId: string; exitCode: number; findingCount: number }
  | { type: "failed"; scanId: string; error: string }
  | { type: "cancelled"; scanId: string }

export type UpdateCheckResult =
  | { state: "available"; version: string; currentVersion: string; notes: string | null }
  | { state: "not_available"; currentVersion: string }
  | { state: "license_expired"; currentVersion: string; perpetualFallbackBuild: string | null }
  | { state: "no_license" }
  | { state: "error"; message: string }

export interface UpdateProgress {
  downloadedBytes: number
  totalBytes: number | null
  finished: boolean
}

export interface SyncConnection {
  workspaceId: string
  seq: number
  lastSyncedFindingId: string | null
  cursor: string | null
  connectedAt: string
  lastSyncAt: string | null
}

export type SyncResult =
  | { status: "success"; syncedCount: number; newSeq: number; newCursor: string }
  | { status: "entitlement_missing"; message: string }
  | { status: "cursor_rewind"; serverSeq: number; serverCursor: string; message: string }
  | { status: "error"; message: string }
