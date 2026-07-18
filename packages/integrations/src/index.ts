export { logger, createLogger } from "@lyrashield/logger"
export type { LogLevel, LogEntry } from "@lyrashield/logger"

export {
  createAppJWT,
  getInstallationToken,
  listInstallationRepos,
  getAppInstallations,
  verifyWebhookSignature,
  getInstallAppUrl,
  getDefaultBranch,
  getBranchRefSha,
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

export { getRedis, closeRedis } from "./redis"
export {
  getScanQueue,
  getScanQueueEvents,
  enqueueScan,
  registerScanWorker,
  unregisterScanWorker,
  isScanWorkerAvailable,
  assertScanWorkerAvailable,
  ScanWorkerUnavailableError,
  SCAN_WORKER_HEARTBEAT_MS,
  SCAN_WORKER_TTL_MS,
} from "./queue"
