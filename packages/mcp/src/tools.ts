import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js"
import {
  createScanTargetTool,
  createCancelScanTool,
  createGetFindingsTool,
  createGetLaunchReadinessTool,
  createCreateReportTool,
  createListWorkspacesTool,
  createListTargetsTool,
  createGetScanStatusTool,
  createGetScanQualityTool,
  createGetScanEligibilityTool,
} from "./tools-core"
import {
  createCheckDiffTool,
  createRunPrScanTool,
  createExplainFindingTool,
  createGenerateFixPlanTool,
  createRecordFixProposalTool,
  createVerifyFixTool,
  createPrSecurityRecapTool,
} from "./tools-workflow"
import {
  createListScanAttachmentsTool,
  createUploadScanAttachmentTool,
  createDeleteScanAttachmentTool,
  createRequestFixPrTool,
} from "./tools-attachments"
import type { McpTool, ToolHandlerContext } from "./tool-shared"

export {
  McpToolResultSchema,
  type McpTool,
  type McpToolResult,
  type ToolHandlerContext,
} from "./tool-shared"
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
  createGetScanEligibilityTool,
} from "./tools-core"
export {
  createCheckDiffTool,
  createRunPrScanTool,
  createExplainFindingTool,
  createGenerateFixPlanTool,
  createRecordFixProposalTool,
  createVerifyFixTool,
  createPrSecurityRecapTool,
} from "./tools-workflow"
export {
  createListScanAttachmentsTool,
  createUploadScanAttachmentTool,
  createDeleteScanAttachmentTool,
  createRequestFixPrTool,
} from "./tools-attachments"

export const MCP_TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  lyrashield_scan_target: {
    title: "Run a LyraShield scan",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  lyrashield_get_findings: {
    title: "Get findings",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  lyrashield_get_launch_readiness: {
    title: "Get launch readiness",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  lyrashield_create_report: {
    title: "Create security report",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  lyrashield_list_workspaces: {
    title: "List workspaces",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  lyrashield_list_targets: {
    title: "List targets",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  lyrashield_get_scan_status: {
    title: "Get scan status",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  lyrashield_get_scan_quality: {
    title: "Get scan evidence quality",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  lyrashield_get_scan_eligibility: {
    title: "Check scan eligibility (advisory preflight)",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  lyrashield_check_diff: {
    title: "Check a diff",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  lyrashield_run_pr_scan: {
    title: "Run a pull-request scan",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  lyrashield_cancel_scan: {
    title: "Cancel a scan",
    readOnlyHint: false,
    destructiveHint: false,
    // Repeating a cancel with the same idempotency key replays the recorded
    // result; without one, a second call conflicts on the now-terminal scan.
    idempotentHint: true,
    openWorldHint: false,
  },
  lyrashield_explain_finding: {
    title: "Explain a finding",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  lyrashield_generate_fix_plan: {
    title: "Generate a fix plan",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  lyrashield_record_fix_proposal: {
    title: "Record a fix proposal",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  lyrashield_verify_fix: {
    title: "Verify a fix",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  lyrashield_create_pr_security_recap: {
    title: "Create pull-request security recap",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  lyrashield_list_scan_attachments: {
    title: "List scan attachments",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  lyrashield_upload_scan_attachment: {
    title: "Upload a scan attachment",
    readOnlyHint: false,
    destructiveHint: false,
    // Repeating with the same idempotency key replays the recorded upload.
    idempotentHint: true,
    openWorldHint: false,
  },
  lyrashield_delete_scan_attachment: {
    title: "Delete a scan attachment",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  lyrashield_request_fix_pr: {
    title: "Request a fix pull request",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
}

export function createAllTools(context: ToolHandlerContext): McpTool[] {
  return [
    // Discovery
    createListWorkspacesTool(context),
    createListTargetsTool(context),
    createGetScanStatusTool(context),
    createGetScanQualityTool(context),
    createGetScanEligibilityTool(context),
    // Core
    createScanTargetTool(context),
    createCancelScanTool(context),
    createGetFindingsTool(context),
    createGetLaunchReadinessTool(context),
    createCreateReportTool(context),
    // Workflow loop
    createCheckDiffTool(context),
    createRunPrScanTool(context),
    createExplainFindingTool(context),
    createGenerateFixPlanTool(context),
    createRecordFixProposalTool(context),
    createVerifyFixTool(context),
    createPrSecurityRecapTool(context),
    // Attachment + fix-PR exposure (D2) — separate block to keep the map
    // diffs minimal against other workstreams touching this catalog.
    createListScanAttachmentsTool(context),
    createUploadScanAttachmentTool(context),
    createDeleteScanAttachmentTool(context),
    createRequestFixPrTool(context),
  ]
}
