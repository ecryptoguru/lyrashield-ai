export { logger, createLogger } from "@lyrashield/logger"
export type { LogLevel, LogEntry } from "@lyrashield/logger"

export {
  createAppJWT,
  getInstallationToken,
  listInstallationRepos,
  getAppInstallations,
  exchangeInstallUserCode,
  userCanAdminInstallation,
  GitHubOwnershipError,
  verifyWebhookSignature,
  getInstallAppUrl,
  getDefaultBranch,
  getBranchRefSha,
  getMergeBaseSha,
  getFileContent,
  createBranch,
  createOrUpdateFile,
  createPullRequest,
} from "./github"
export type { GitHubRepo, InstallationInfo } from "./github"

export {
  sendNotification,
  channels,
  type NotificationChannel,
  type NotificationPayload,
  type NotificationChannelSender,
} from "./notifications"

export {
  CONNECTOR_PROVIDERS,
  capConnectorOutput,
  ConnectorOutputError,
  type ConnectorCredential,
  type ConnectorInvocationContext,
  type ConnectorProvider,
  type ConnectorTool,
  type ConnectorToolResult,
} from "./connectors/types"
export {
  CONNECTOR_TOOLS,
  getConnectorTool,
  listConnectorTools,
  connectorToolResource,
} from "./connectors/registry"
export { githubConnectorTools, GitHubConnectorError } from "./connectors/github"
export {
  slackConnectorTools,
  slackApi,
  exchangeSlackOAuthCode,
  getSlackAuthorizeUrl,
  SlackConnectorError,
  SLACK_READ_METHODS,
  SLACK_CONNECT_SCOPES,
  type SlackReadMethod,
  type SlackOAuthExchangeResult,
} from "./connectors/slack"
export {
  evaluateConnectorAdmission,
  getConnectorAdmission,
  type ConnectorAdmissionDecision,
  type ConnectorAdmissionMode,
  type ConnectorAdmissionReason,
} from "./connectors/admission"

export { getRedis, closeRedis } from "./redis"
export {
  getScanQueue,
  enqueueScan,
  getScanQueuePosition,
  registerScanWorker,
  unregisterScanWorker,
  isScanWorkerAvailable,
  assertScanWorkerAvailable,
  ScanWorkerUnavailableError,
  SCAN_ADMISSION_STOP_KEY,
  SCAN_WORKER_HEARTBEAT_MS,
  SCAN_WORKER_TTL_MS,
  type ScanQueuePosition,
} from "./queue"
export {
  WEBHOOK_TRACK_RETRY_QUEUE_NAME,
  getWebhookTrackRetryQueue,
  enqueueWebhookTrackRetry,
  type WebhookTrackRetryJobData,
} from "./queue"
export { FIX_GENERATE_QUEUE_NAME, enqueueFixGenerate, type FixGenerateJobData } from "./queue"
