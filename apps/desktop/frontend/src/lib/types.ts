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

interface EngineInfo {
  found: boolean
  path: string | null
  version: string | null
}

interface DockerInfo {
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

// Stored records may carry retired values ("url" — a target kind, never an
// engine depth — and "unknown" for unparseable legacy rows). New launches use
// only the three public depths: quick, standard, deep.
export type ScanMode = "safe" | "quick" | "standard" | "deep" | "custom" | "url" | "unknown"

export type ScanTarget =
  | { type: "repo"; path: string; branch: string | null }
  | { type: "url"; url: string }
  | { type: "local_path"; path: string }

// Recorded workflow — the same contract tokens as the API/SDK/CLI/MCP.
// "unknown" only marks rows written before workflow tracking; new launches
// always send REVIEW_TARGET or REVIEW_CHANGES. AUTHENTICATED_ASSESSMENT is
// hosted-only and never offered here.
export type ScanWorkflow = "REVIEW_TARGET" | "REVIEW_CHANGES" | "unknown"

// Execution backend: "local" is the bundled BYOK engine; "cloud" is a
// recorded scan submitted to the hosted API — only ever an explicit user
// action, never a silent substitution.
export type ScanBackend = "local" | "cloud"

export interface Finding {
  id: string
  severity: string
  title: string
  description: string | null
  filePath: string | null
  lineNumber: number | null
  status: string
  // Legacy flag — always false for local findings; verificationState is the
  // authoritative tier.
  verified: boolean
  // A local run can only ever produce "DETECTED" — a recorded observation,
  // never VALIDATED or VERIFIED.
  verificationState: string
  // Engine attested evidence (verified claim, fix check, exchange refs) not
  // yet exported — render "engine-attested; evidence export pending".
  evidencePending: boolean
  counterevidence: string | null
  confidenceRationale: string | null
  fixVerification: string | null
  httpExchangeIds: string[]
  detectedAt: string
}

export type ScanStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  // Recorded cloud scan submitted — progress/evidence live server-side.
  | "submitted"

export interface ScanSummary {
  scanId: string
  target: string
  mode: ScanMode
  workflow: ScanWorkflow
  backend: ScanBackend
  contractVersion: string | null
  diffBase: string | null
  diffHead: string | null
  status: ScanStatus
  startedAt: string
  completedAt: string | null
  findingCount: number
}

export interface ScanDetail {
  scanId: string
  target: string
  mode: ScanMode
  workflow: ScanWorkflow
  backend: ScanBackend
  contractVersion: string | null
  diffBase: string | null
  diffHead: string | null
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
  | { type: "error"; scanId: string; error: string }

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

// A connected LyraShield Cloud target eligible for recorded scan submission.
export interface CloudTarget {
  id: string
  label: string
  targetType: string
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
  | { status: "cursor_rewind"; serverSeq: number; message: string }
  | { status: "error"; message: string }
