import { z } from "zod"
import {
  CreateScanSchema,
  ScanStatusSchema,
  ScanGoalSchema,
  ScanModeSchema,
  FindingSeveritySchema,
  FindingStatusSchema,
  FindingVerificationStatusSchema,
  CreateWorkspaceSchema,
  CreateRepoTargetSchema,
  CreateUrlTargetSchema,
  PatchTargetSchema,
  CreateProjectSchema,
  CreateReportSchema,
  ReportActionSchema,
  CreateFixProposalSchema,
  CreateRetestSchema,
  PatchFindingSchema,
  CreateScheduleSchema,
  PatchScheduleSchema,
  FindingQuerySchema,
  CreatePRSchema,
} from ".."
import { ScanExecutionPlanSchema } from "../scan-execution-plan"
import {
  securitySchemes,
  workspaceIdParam,
  idPathParam,
  successEnvelope,
  errorEnvelope,
  paginatedEnvelope,
} from "./components"

function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>
  delete json.$schema
  return json
}

function ref(name: string): { $ref: string } {
  return { $ref: `#/components/schemas/${name}` }
}

const jsonErrors = { "application/json": { schema: errorEnvelope } }

const badRequest = { description: "Bad request", content: jsonErrors }
const unauthorized = { description: "Unauthorized", content: jsonErrors }
const forbidden = { description: "Forbidden", content: jsonErrors }
const notFound = { description: "Not found", content: jsonErrors }
const conflict = { description: "Conflict", content: jsonErrors }
const unprocessable = { description: "Validation failed", content: jsonErrors }
const tooManyRequests = {
  description: "Rate limited",
  headers: {
    "Retry-After": { schema: { type: "string" }, description: "Seconds to wait before retrying" },
  },
  content: jsonErrors,
}
const serverError = { description: "Internal server error", content: jsonErrors }
const serviceUnavailable = { description: "Service temporarily unavailable", content: jsonErrors }

const commonErrors: Record<string, unknown> = {
  400: badRequest,
  401: unauthorized,
  403: forbidden,
  404: notFound,
  409: conflict,
  422: unprocessable,
  429: tooManyRequests,
  500: serverError,
  503: serviceUnavailable,
}

function successResponse(dataSchema: unknown, description = "Success"): Record<string, unknown> {
  return {
    description,
    content: {
      "application/json": {
        schema: {
          allOf: [
            successEnvelope,
            { type: "object", properties: { data: dataSchema }, required: ["data"] },
          ],
        },
      },
    },
  }
}

function paginatedResponse(itemSchema: unknown, description = "Success"): Record<string, unknown> {
  return successResponse(
    {
      allOf: [
        paginatedEnvelope,
        {
          type: "object",
          properties: { items: { type: "array", items: itemSchema } },
          required: ["items"],
        },
      ],
    },
    description
  )
}

function queryParamsFromSchema(
  schema: Record<string, unknown>,
  {
    include = "all",
    exclude = ["workspaceId"],
  }: { include?: string[] | "all"; exclude?: string[] } = {}
): unknown[] {
  const properties = (schema.properties ?? {}) as Record<string, unknown>
  const required = new Set<string>(
    Array.isArray(schema.required) ? (schema.required as string[]) : []
  )
  const keys = include === "all" ? Object.keys(properties) : include
  return keys
    .filter((key) => !exclude.includes(key))
    .map((name) => ({
      name,
      in: "query" as const,
      required: required.has(name),
      schema: properties[name],
    }))
}

export function buildOpenApiSpec(): Record<string, unknown> {
  const schemas: Record<string, unknown> = {
    CreateScan: toJsonSchema(CreateScanSchema),
    ScanStatus: toJsonSchema(ScanStatusSchema),
    ScanGoal: toJsonSchema(ScanGoalSchema),
    ScanMode: toJsonSchema(ScanModeSchema),
    FindingSeverity: toJsonSchema(FindingSeveritySchema),
    FindingStatus: toJsonSchema(FindingStatusSchema),
    FindingVerificationStatus: toJsonSchema(FindingVerificationStatusSchema),
    ScanExecutionPlan: {
      ...toJsonSchema(ScanExecutionPlanSchema),
      description:
        "Server-owned immutable execution plan recorded on each scan (lyrashield-scan-plan/1.0.0): workflow, target type, explicit depth, scope, resolved immutable source revisions, limits, capabilities and attachment references. Never client-supplied; absent only on legacy pre-plan scans.",
    },
    Scan: {
      type: "object",
      description:
        "Scan result. `executionPlan` carries the recorded workflow, scope and resolved immutable provenance; `executionPlanHash` is its content digest. A null plan means not recorded (legacy row), never an inferred plan.",
      additionalProperties: true,
      properties: {
        id: { type: "string" },
        status: ref("ScanStatus"),
        mode: ref("ScanMode"),
        goal: ref("ScanGoal"),
        targetId: { type: "string" },
        queuePosition: { type: "integer", nullable: true },
        executionPlan: { anyOf: [ref("ScanExecutionPlan"), { type: "null" }] },
        executionPlanHash: { type: "string", nullable: true },
        createdAt: { type: "string", format: "date-time" },
        completedAt: { type: "string", format: "date-time", nullable: true },
      },
      required: ["id", "status", "mode", "goal"],
    },
    Finding: {
      type: "object",
      description:
        "Finding result with explicit verification trust tiers. `verified` is the legacy boolean summary; `verificationStatus` is the authoritative tier — DETECTED (recorded observation), VALIDATED (deterministic check), VERIFIED (independent confirmation), or the non-conclusive BLOCKED/INCONCLUSIVE. Clients must never conflate the tiers or present DETECTED as verified.",
      additionalProperties: true,
      properties: {
        id: { type: "string" },
        severity: ref("FindingSeverity"),
        status: ref("FindingStatus"),
        title: { type: "string" },
        verified: { type: "boolean" },
        verificationStatus: ref("FindingVerificationStatus"),
        verificationMethod: { type: "string", nullable: true },
        verificationReason: { type: "string", nullable: true },
      },
      required: ["id", "severity", "status", "title"],
    },
    CreateWorkspace: toJsonSchema(CreateWorkspaceSchema),
    CreateRepoTarget: toJsonSchema(CreateRepoTargetSchema),
    CreateUrlTarget: toJsonSchema(CreateUrlTargetSchema),
    PatchTarget: toJsonSchema(PatchTargetSchema),
    CreateProject: toJsonSchema(CreateProjectSchema),
    CreateReport: toJsonSchema(CreateReportSchema),
    ReportAction: toJsonSchema(ReportActionSchema),
    CreateFixProposal: toJsonSchema(CreateFixProposalSchema),
    CreateRetest: toJsonSchema(CreateRetestSchema),
    PatchFinding: toJsonSchema(PatchFindingSchema),
    CreateSchedule: toJsonSchema(CreateScheduleSchema),
    PatchSchedule: toJsonSchema(PatchScheduleSchema),
    FindingQuery: toJsonSchema(FindingQuerySchema),
    CreatePR: toJsonSchema(CreatePRSchema),
    successEnvelope,
    errorEnvelope,
    paginatedEnvelope,
  }

  const findingQueryJson = schemas.FindingQuery as Record<string, unknown>

  const genericItem = {
    type: "object",
    additionalProperties: true,
    description: "See response examples",
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "LyraShield AI API",
      version: "1.0.0",
      description:
        "Curated public v1 surface for scans, findings, targets, fix proposals, retests, reports, launch readiness, workspaces, schedules, and projects.",
    },
    servers: [{ url: "/api/v1", description: "Version 1 API root" }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/scans": {
        get: {
          summary: "List scans",
          parameters: [
            workspaceIdParam,
            { name: "targetId", in: "query", required: false, schema: { type: "string" } },
            {
              name: "status",
              in: "query",
              required: false,
              schema: { type: "string", description: "Single status or comma-separated list" },
            },
            { name: "cursor", in: "query", required: false, schema: { type: "string" } },
            { name: "limit", in: "query", required: false, schema: { type: "string" } },
            { name: "If-None-Match", in: "header", required: false, schema: { type: "string" } },
          ],
          responses: {
            200: paginatedResponse(ref("Scan"), "List of scans"),
            304: { description: "Not Modified", headers: { ETag: { schema: { type: "string" } } } },
            ...commonErrors,
          },
        },
        post: {
          summary: "Create a scan",
          description:
            "Creates a recorded scan with a server-owned immutable execution plan. `workflow` selects REVIEW_TARGET (default) or REVIEW_CHANGES (repository diff review — requires `baseRef`, optional `headRef`); `attachmentIds` reference previously staged workspace artifacts. AUTHENTICATED_ASSESSMENT returns SCAN_WORKFLOW_UNAVAILABLE (400) until wired. Advisory local checks (CLI check-diff, GitHub Action gate) are never equivalent to this recorded path.",
          parameters: [workspaceIdParam],
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref("CreateScan") } },
          },
          responses: {
            201: successResponse(ref("Scan"), "Scan created"),
            ...commonErrors,
          },
        },
      },
      "/scans/{id}": {
        get: {
          summary: "Get a scan",
          description:
            "Returns the scan with its recorded execution plan (workflow, scope, resolved immutable source revisions), events, result-manifest checksum, and coverage receipts.",
          parameters: [
            idPathParam,
            workspaceIdParam,
            { name: "If-None-Match", in: "header", required: false, schema: { type: "string" } },
          ],
          responses: {
            200: successResponse(ref("Scan"), "Scan details"),
            304: { description: "Not Modified", headers: { ETag: { schema: { type: "string" } } } },
            ...commonErrors,
          },
        },
        post: {
          summary: "Cancel a scan",
          parameters: [idPathParam, workspaceIdParam],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { workspaceId: { type: "string" } },
                  required: ["workspaceId"],
                },
              },
            },
          },
          responses: {
            200: successResponse(genericItem, "Scan cancelled"),
            ...commonErrors,
          },
        },
      },
      "/scans/{id}/artifacts/sarif": {
        post: {
          summary: "Import a SARIF report into a scan",
          description:
            "Imports third-party SARIF 2.1.0 detections into an existing scan. Imported findings are tagged external_import and never count as scanner coverage or independently verified findings. Requires a write-scoped API key or browser session; delegated OAuth connections are refused.",
          parameters: [idPathParam, workspaceIdParam],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: {
            200: successResponse(genericItem, "SARIF findings imported"),
            413: {
              description: "SARIF payload exceeds the 5 MiB limit",
              content: { "application/json": { schema: errorEnvelope } },
            },
            ...commonErrors,
          },
        },
      },
      "/findings": {
        get: {
          summary: "List findings",
          parameters: [workspaceIdParam, ...queryParamsFromSchema(findingQueryJson)],
          responses: {
            200: paginatedResponse(ref("Finding"), "List of findings"),
            ...commonErrors,
          },
        },
      },
      "/findings/{id}": {
        get: {
          summary: "Get a finding",
          parameters: [idPathParam, workspaceIdParam],
          responses: {
            200: successResponse(ref("Finding"), "Finding details"),
            ...commonErrors,
          },
        },
        patch: {
          summary: "Update a finding",
          parameters: [idPathParam, workspaceIdParam],
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref("PatchFinding") } },
          },
          responses: {
            200: successResponse(genericItem, "Finding updated"),
            ...commonErrors,
          },
        },
      },
      "/findings/{id}/fix-proposals": {
        post: {
          summary: "Create a fix proposal",
          parameters: [idPathParam, workspaceIdParam],
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref("CreateFixProposal") } },
          },
          responses: {
            200: successResponse(genericItem, "Fix proposal created"),
            ...commonErrors,
          },
        },
      },
      "/findings/{id}/retests": {
        post: {
          summary: "Queue a retest",
          parameters: [idPathParam, workspaceIdParam],
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref("CreateRetest") } },
          },
          responses: {
            201: successResponse(genericItem, "Retest queued"),
            ...commonErrors,
          },
        },
      },
      "/targets": {
        get: {
          summary: "List targets",
          parameters: [
            workspaceIdParam,
            { name: "projectId", in: "query", required: false, schema: { type: "string" } },
            { name: "cursor", in: "query", required: false, schema: { type: "string" } },
            { name: "limit", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: {
            200: paginatedResponse(genericItem, "List of targets"),
            ...commonErrors,
          },
        },
        post: {
          summary: "Create a target",
          parameters: [workspaceIdParam],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { oneOf: [ref("CreateRepoTarget"), ref("CreateUrlTarget")] },
              },
            },
          },
          responses: {
            200: successResponse(genericItem, "Target created"),
            ...commonErrors,
          },
        },
      },
      "/targets/{id}": {
        patch: {
          summary: "Update a target",
          parameters: [idPathParam, workspaceIdParam],
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref("PatchTarget") } },
          },
          responses: {
            200: successResponse(genericItem, "Target updated"),
            ...commonErrors,
            409: {
              description: "Repository ref is immutable after the first scan",
              content: { "application/json": { schema: errorEnvelope } },
            },
          },
        },
        delete: {
          summary: "Delete a target (soft delete)",
          description:
            "Marks the target deleted and frees its plan target slot. Scans, findings, verdicts, reports and evidence are retained in the workspace. Refused while a scan for the target is queued or running.",
          parameters: [idPathParam, workspaceIdParam],
          responses: {
            204: { description: "Target deleted" },
            ...commonErrors,
            404: {
              description: "Target not found or already deleted",
              content: { "application/json": { schema: errorEnvelope } },
            },
            409: {
              description: "Target has a queued or running scan",
              content: { "application/json": { schema: errorEnvelope } },
            },
          },
        },
      },
      "/fix-proposals": {
        get: {
          summary: "List fix proposals",
          parameters: [
            workspaceIdParam,
            { name: "findingId", in: "query", required: false, schema: { type: "string" } },
            { name: "status", in: "query", required: false, schema: { type: "string" } },
            { name: "cursor", in: "query", required: false, schema: { type: "string" } },
            { name: "limit", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: {
            200: paginatedResponse(genericItem, "List of fix proposals"),
            ...commonErrors,
          },
        },
      },
      "/fix-proposals/{id}/create-pr": {
        post: {
          summary: "Create a pull request",
          parameters: [idPathParam, workspaceIdParam],
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref("CreatePR") } },
          },
          responses: {
            ...commonErrors,
            409: {
              description:
                "Pull request creation is blocked pending server-generated patch evidence",
              content: { "application/json": { schema: errorEnvelope } },
            },
          },
        },
      },
      "/retests": {
        get: {
          summary: "List retests",
          parameters: [
            workspaceIdParam,
            { name: "findingId", in: "query", required: false, schema: { type: "string" } },
            { name: "status", in: "query", required: false, schema: { type: "string" } },
            { name: "cursor", in: "query", required: false, schema: { type: "string" } },
            { name: "limit", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: {
            200: paginatedResponse(genericItem, "List of retests"),
            ...commonErrors,
          },
        },
      },
      "/reports": {
        get: {
          summary: "List reports",
          parameters: [
            workspaceIdParam,
            { name: "cursor", in: "query", required: false, schema: { type: "string" } },
            { name: "limit", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: {
            200: paginatedResponse(genericItem, "List of reports"),
            ...commonErrors,
          },
        },
        post: {
          summary: "Create a report",
          parameters: [workspaceIdParam],
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref("CreateReport") } },
          },
          responses: {
            201: successResponse(genericItem, "Report created"),
            ...commonErrors,
          },
        },
      },
      "/reports/{id}": {
        get: {
          summary: "Get a report",
          parameters: [idPathParam, workspaceIdParam],
          responses: {
            200: successResponse(genericItem, "Report details"),
            ...commonErrors,
          },
        },
        post: {
          summary: "Share or revoke a report",
          parameters: [idPathParam, workspaceIdParam],
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref("ReportAction") } },
          },
          responses: {
            200: successResponse(genericItem, "Report action completed"),
            ...commonErrors,
          },
        },
      },
      "/reports/{id}/download": {
        get: {
          summary: "Download a report",
          parameters: [idPathParam, workspaceIdParam],
          responses: {
            200: {
              description: "Report HTML",
              content: { "text/html": { schema: { type: "string" } } },
            },
            ...commonErrors,
          },
        },
      },
      "/launch-readiness": {
        get: {
          summary: "Launch readiness report",
          parameters: [
            workspaceIdParam,
            { name: "targetId", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: {
            200: successResponse(genericItem, "Launch readiness summary"),
            ...commonErrors,
          },
        },
      },
      "/workspaces": {
        get: {
          summary: "List workspaces",
          parameters: [workspaceIdParam],
          responses: {
            200: successResponse({ type: "array", items: genericItem }, "List of workspaces"),
            ...commonErrors,
          },
        },
        post: {
          summary: "Create a workspace",
          parameters: [workspaceIdParam],
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref("CreateWorkspace") } },
          },
          responses: {
            200: successResponse(genericItem, "Workspace created"),
            ...commonErrors,
          },
        },
      },
      "/schedules": {
        get: {
          summary: "List schedules",
          parameters: [
            workspaceIdParam,
            { name: "targetId", in: "query", required: false, schema: { type: "string" } },
            {
              name: "enabled",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["true", "false"] },
            },
            { name: "cursor", in: "query", required: false, schema: { type: "string" } },
            { name: "limit", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: {
            200: paginatedResponse(genericItem, "List of schedules"),
            ...commonErrors,
          },
        },
        post: {
          summary: "Create a schedule",
          parameters: [workspaceIdParam],
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref("CreateSchedule") } },
          },
          responses: {
            201: successResponse(genericItem, "Schedule created"),
            ...commonErrors,
          },
        },
      },
      "/schedules/{id}": {
        get: {
          summary: "Get a schedule",
          parameters: [idPathParam, workspaceIdParam],
          responses: {
            200: successResponse(genericItem, "Schedule details"),
            ...commonErrors,
          },
        },
        patch: {
          summary: "Update a schedule",
          parameters: [idPathParam, workspaceIdParam],
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref("PatchSchedule") } },
          },
          responses: {
            200: successResponse(genericItem, "Schedule updated"),
            ...commonErrors,
          },
        },
        delete: {
          summary: "Delete a schedule",
          parameters: [idPathParam, workspaceIdParam],
          responses: {
            200: successResponse(genericItem, "Schedule deleted"),
            ...commonErrors,
          },
        },
      },
      "/projects": {
        get: {
          summary: "List projects",
          parameters: [
            workspaceIdParam,
            { name: "cursor", in: "query", required: false, schema: { type: "string" } },
            { name: "limit", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: {
            200: paginatedResponse(genericItem, "List of projects"),
            ...commonErrors,
          },
        },
        post: {
          summary: "Create a project",
          parameters: [workspaceIdParam],
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref("CreateProject") } },
          },
          responses: {
            200: successResponse(genericItem, "Project created"),
            ...commonErrors,
          },
        },
      },
      "/agent-approvals": {
        get: {
          summary: "List agent approvals",
          parameters: [
            workspaceIdParam,
            {
              name: "status",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["PENDING", "APPROVED", "DENIED", "EXPIRED"] },
            },
            { name: "cursor", in: "query", required: false, schema: { type: "string" } },
            { name: "limit", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: {
            200: paginatedResponse(genericItem, "List of agent approvals"),
            ...commonErrors,
          },
        },
        post: {
          summary: "Create an agent approval",
          parameters: [workspaceIdParam],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    workspaceId: { type: "string" },
                    actionName: { type: "string" },
                    input: { type: "object" },
                    expiresAt: { type: "string", format: "date-time" },
                  },
                  required: ["workspaceId", "actionName", "input"],
                },
              },
            },
          },
          responses: {
            201: successResponse(genericItem, "Agent approval created"),
            ...commonErrors,
          },
        },
      },
      "/agent-approvals/{id}/approve": {
        post: {
          summary: "Approve an agent action",
          parameters: [idPathParam, workspaceIdParam],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    workspaceId: { type: "string" },
                    input: { type: "object" },
                  },
                  required: ["workspaceId", "input"],
                },
              },
            },
          },
          responses: {
            200: successResponse(genericItem, "Agent approval approved"),
            ...commonErrors,
          },
        },
      },
      "/agent-approvals/{id}/deny": {
        post: {
          summary: "Deny an agent action",
          parameters: [idPathParam, workspaceIdParam],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { workspaceId: { type: "string" } },
                  required: ["workspaceId"],
                },
              },
            },
          },
          responses: {
            200: successResponse(genericItem, "Agent approval denied"),
            ...commonErrors,
          },
        },
      },
    },
    components: {
      securitySchemes,
      schemas,
    },
  }
}
