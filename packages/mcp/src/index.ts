export {
  createScanTargetTool,
  createCancelScanTool,
  createGetFindingsTool,
  createGetLaunchReadinessTool,
  createCreateReportTool,
  createListWorkspacesTool,
  createListTargetsTool,
  createGetScanStatusTool,
  createGetScanQualityTool,
  createCheckDiffTool,
  createRunPrScanTool,
  createExplainFindingTool,
  createGenerateFixPlanTool,
  createRecordFixProposalTool,
  createVerifyFixTool,
  createPrSecurityRecapTool,
  createListScanAttachmentsTool,
  createUploadScanAttachmentTool,
  createDeleteScanAttachmentTool,
  createRequestFixPrTool,
  createAllTools,
  type McpTool,
  type McpToolResult,
  type ToolHandlerContext,
  MCP_TOOL_ANNOTATIONS,
} from "./tools"
export { PromptInjectionGuard, type GuardResult } from "./prompt-injection-guard"
export {
  McpServer,
  type McpServerOptions,
  type ApprovalGate,
  type ApprovalDecision,
} from "./server"
export {
  createLyraShieldServer,
  SERVER_NAME,
  SERVER_TITLE,
  SERVER_VERSION,
  SERVER_DESCRIPTION,
  SERVER_WEBSITE_URL,
  SERVER_INSTRUCTIONS,
  type CreateServerOptions,
  type RemoteApprovalGate,
  type RemoteApprovalContext,
} from "./create-server"
export { handleRemoteMcpRequest, type RemoteMcpOptions } from "./http-transport"
export { MCP_PROTOCOL_SUPPORT } from "./protocol"
export {
  MCP_TASK_PROTOCOL_VERSION,
  MCP_TASK_ID_PREFIX,
  MCP_TASK_TTL_MS,
  MCP_TASK_POLL_INTERVAL_MS,
  TASK_CAPABLE_TOOLS,
  assertTaskCapableTool,
  serializeTaskId,
  parseTaskId,
  isTaskMappingExpired,
  isTerminalTaskStatus,
  mapScanStatusToTaskStatus,
  operationMatchesPrincipal,
  resolveTaskView,
  scanRowToCallToolResult,
  storedResultToCallToolResult,
  buildTask,
  extractScanIdFromOperation,
  extractOperationIdFromToolResult,
  extractScanIdFromToolResult,
  toSdkTaskStore,
  type McpTaskBackend,
  type TaskOperationRecord,
  type TaskScanRecord,
  type TaskView,
} from "./task-adapter"
export { createLocalTaskBackend } from "./local-task-backend"
// Re-export the SDK types the task surface is built on, so consumers
// (apps/web) do not need a direct SDK dependency to implement a backend.
export { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js"
export type { Task, CallToolResult } from "@modelcontextprotocol/sdk/types.js"
