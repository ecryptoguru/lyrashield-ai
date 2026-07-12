export {
  WorkspaceMode,
  WorkspacePlan,
  MemberRole,
  TargetType,
  TargetEnvironment,
  ScanGoal,
  ScanMode,
  ScanStatus,
  FindingSeverity,
  FindingStatus,
  IntegrationType,
  ScoreGrade,
  ReferralStatus,
} from "./generated/prisma"

export type {
  Workspace,
  WorkspaceMember,
  Project,
  Target,
  CredentialSet,
  Policy,
  Scan,
  ScanEvent,
  ApiKey,
  Finding,
  Evidence,
  FixProposal,
  PullRequest,
  Ticket,
  Integration,
  UsageRecord,
  AuditLog,
  Report,
  Notification,
  Schedule,
  BillingAccount,
  Invitation,
  WebhookEvent,
  Retest,
  OnboardingState,
  AgentApproval,
  User,
  Session,
  Account,
  Verification,
} from "./generated/prisma"

export { ApprovalStatus } from "./generated/prisma"

export { Prisma } from "./generated/prisma"

export { prisma } from "./client"
export { setWorkspaceContext, getWorkspaceContext, runWithWorkspaceContext } from "./extension"
export { computeAuditHash, verifyAuditChain, type AuditLogChainFields } from "./audit-hash"
export {
  assertEvidenceEncrypted,
  isEvidenceEncrypted,
  isValidKeyRefFormat,
  EvidenceEncryptionError,
} from "./evidence"
export { withWorkspaceRLS, withoutWorkspaceRLS } from "./rls"
export { deleteUserAccount, AccountDeletionBlockedError } from "./account-deletion"
export {
  createScan,
  updateScanStatus,
  addScanEvent,
  getScanWithEvents,
  getScanForWorkspace,
  listScans,
  cancelScan,
  type CreateScanParams,
  type ScanWithEvents,
  type ListScansParams,
} from "./scan-service"
export { isValidTransition, VALID_TRANSITIONS } from "./scan-transitions"
export {
  completeScanWithScore,
  createScorecardShare,
  revokeScorecardShare,
  getPublicScorecard,
  getOrCreateReferralCode,
  attributeReferral,
  qualifyReferralForWorkspace,
  buildScorecardPayload,
  type ScorecardPayload,
} from "./score-service"
export {
  listFindings,
  getFinding,
  updateFindingStatus,
  markFalsePositive,
  acceptRisk,
  getFindingStats,
  listFindingsByScan,
  type ListFindingsParams,
  type FindingStats,
} from "./finding-service"
export {
  createReport,
  generateShareToken,
  revokeShareToken,
  getReportByShareToken,
  getShareableReport,
  listReports,
  type CreateReportParams,
  type ShareableReport,
} from "./report-service"
export {
  createFixProposal,
  getFixProposal,
  listFixProposals,
  updateFixProposalStatus,
  createPullRequestRecord,
  type CreateFixProposalParams,
  type FixProposalWithDetails,
} from "./fix-proposal-service"
export {
  createRetest,
  getRetest,
  listRetests,
  updateRetestStatus,
  type RetestWithDetails,
} from "./retest-service"
export { gatherReportData, generateReportHTML, type ReportData } from "./report-generator"
export {
  createNotification,
  getNotification,
  listNotifications,
  markNotificationSent,
  markNotificationRead,
  updateNotificationStatus,
  createAndSendNotification,
} from "./notification-service"
export {
  createSchedule,
  getSchedule,
  listSchedules,
  updateSchedule,
  deleteSchedule,
  updateScheduleRunTimes,
  claimDueSchedule,
  getDueSchedules,
  getNextRunAt,
  type ScheduleWithDetails,
} from "./schedule-service"
export {
  createApproval,
  getApproval,
  listApprovals,
  approveApproval,
  denyApproval,
  saveApprovalResult,
  expireStaleApprovals,
  hashInput,
  verifyInputHash,
  type CreateApprovalParams,
  type ListApprovalsParams,
} from "./agent-approval-service"
