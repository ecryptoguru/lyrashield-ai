import { prisma, listFindings, getFinding, createScan, getScanWithEvents } from "@lyrashield/db"
import { PERMISSIONS } from "@lyrashield/auth"
import {
  ListTargetsInputSchema,
  RunScanInputSchema,
  GetScanStatusInputSchema,
  ListFindingsInputSchema,
  GetFindingInputSchema,
  ExplainFindingInputSchema,
  type AgentActionDefinition,
} from "@lyrashield/types"
import { z } from "zod"
import { logger } from "@lyrashield/logger"
import { explainFinding } from "./plain-language-bridge"
import { enqueueScanJob } from "./queue"

export const listTargetsAction: AgentActionDefinition<z.infer<typeof ListTargetsInputSchema>> = {
  name: "list-targets",
  description: "List all targets in the workspace, optionally filtered by project.",
  inputSchema: ListTargetsInputSchema,
  permission: PERMISSIONS.agent.view,
  auditAction: "agent.action.list_targets",
  auditResourceType: "target",
  handler: async (input) => {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100)
    const targets = await prisma.target.findMany({
      where: {
        workspaceId: input.workspaceId,
        deletedAt: null,
        ...(input.projectId ? { projectId: input.projectId } : {}),
      },
      include: {
        project: { select: { id: true, name: true } },
        _count: { select: { scans: true, findings: true } },
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    })

    const hasMore = targets.length > limit
    const items = hasMore ? targets.slice(0, limit) : targets
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.id : null

    return {
      items: items.map((t) => ({
        id: t.id,
        name: t.name,
        type: t.type,
        url: t.url,
        repoFullName: t.repoFullName,
        branch: t.branch,
        environment: t.environment,
        status: t.status,
        projectId: t.projectId,
        scanCount: t._count.scans,
        findingCount: t._count.findings,
      })),
      nextCursor,
    }
  },
}

export const runScanAction: AgentActionDefinition<z.infer<typeof RunScanInputSchema>> = {
  name: "run-scan",
  description: "Trigger a security scan on a target. Requires agent:act permission.",
  inputSchema: RunScanInputSchema,
  permission: PERMISSIONS.agent.act,
  needsApproval: (input) => input.mode === "DEEP",
  auditAction: "agent.action.run_scan",
  auditResourceType: "scan",
  handler: async (input, context) => {
    const target = await prisma.target.findFirst({
      where: { id: input.targetId, workspaceId: input.workspaceId, deletedAt: null },
    })
    if (!target) {
      throw new Error("Target not found in this workspace")
    }

    if (input.policyId) {
      const policy = await prisma.policy.findFirst({
        where: { id: input.policyId, workspaceId: input.workspaceId, deletedAt: null },
      })
      if (!policy) {
        throw new Error("Policy not found in this workspace")
      }
    }

    const activeScans = await prisma.scan.count({
      where: {
        targetId: input.targetId,
        status: { in: ["QUEUED", "PREFLIGHT", "RUNNING", "VERIFYING"] },
      },
    })
    if (activeScans > 0) {
      throw new Error("Target already has an active scan")
    }

    const scan = await createScan({
      workspaceId: input.workspaceId,
      targetId: input.targetId,
      goal: input.goal,
      mode: input.mode,
      policyId: input.policyId,
      createdById: context.userId,
      triggerType: "agent",
    })

    try {
      await enqueueScanJob({
        scanId: scan.id,
        workspaceId: input.workspaceId,
        targetId: input.targetId,
        goal: input.goal,
        mode: input.mode,
        policyId: input.policyId,
      })
    } catch (enqueueErr) {
      logger.error("Failed to enqueue scan job from agent action", {
        scanId: scan.id,
        error: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
      })
      await prisma.scan.update({
        where: { id: scan.id },
        data: {
          status: "FAILED",
          errorCategory: "QUEUE",
          errorMessage: "Failed to enqueue scan job — Redis may be unavailable",
          endedAt: new Date(),
        },
      })
      throw new Error("Scan created but failed to enqueue — Redis may be unavailable")
    }

    logger.info("Agent triggered scan", { scanId: scan.id, targetId: input.targetId })

    return {
      id: scan.id,
      status: scan.status,
      goal: scan.goal,
      mode: scan.mode,
      targetId: scan.targetId,
    }
  },
}

export const getScanStatusAction: AgentActionDefinition<z.infer<typeof GetScanStatusInputSchema>> = {
  name: "get-scan-status",
  description: "Get the current status and events of a scan.",
  inputSchema: GetScanStatusInputSchema,
  permission: PERMISSIONS.agent.view,
  auditAction: "agent.action.get_scan_status",
  auditResourceType: "scan",
  handler: async (input) => {
    const scan = await getScanWithEvents(input.scanId)
    if (!scan || scan.workspaceId !== input.workspaceId) {
      throw new Error("Scan not found in this workspace")
    }

    return {
      id: scan.id,
      status: scan.status,
      goal: scan.goal,
      mode: scan.mode,
      startedAt: scan.startedAt,
      endedAt: scan.endedAt,
      summary: scan.summary,
      errorCategory: scan.errorCategory,
      errorMessage: scan.errorMessage,
      events: scan.events.map((e) => ({
        id: e.id,
        stage: e.stage,
        level: e.level,
        message: e.message,
        createdAt: e.createdAt,
      })),
    }
  },
}

export const listFindingsAction: AgentActionDefinition<z.infer<typeof ListFindingsInputSchema>> = {
  name: "list-findings",
  description: "List security findings, optionally filtered by target, scan, severity, or status.",
  inputSchema: ListFindingsInputSchema,
  permission: PERMISSIONS.agent.view,
  auditAction: "agent.action.list_findings",
  auditResourceType: "finding",
  handler: async (input) => {
    const { items, nextCursor } = await listFindings({
      workspaceId: input.workspaceId,
      ...(input.targetId ? { targetId: input.targetId } : {}),
      ...(input.scanId ? { scanId: input.scanId } : {}),
      ...(input.severity ? { severity: input.severity } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      limit: input.limit,
    })

    return {
      items: items.map((f) => ({
        id: f.id,
        title: f.title,
        severity: f.severity,
        status: f.status,
        cwe: f.cwe,
        category: f.category,
        verified: f.verified,
        targetId: f.targetId,
        scanId: f.scanId,
        createdAt: f.createdAt,
      })),
      nextCursor,
    }
  },
}

export const getFindingAction: AgentActionDefinition<z.infer<typeof GetFindingInputSchema>> = {
  name: "get-finding",
  description: "Get detailed information about a specific finding, including evidence and fix proposals.",
  inputSchema: GetFindingInputSchema,
  permission: PERMISSIONS.agent.view,
  auditAction: "agent.action.get_finding",
  auditResourceType: "finding",
  handler: async (input) => {
    const finding = await getFinding(input.findingId, input.workspaceId)
    if (!finding) {
      throw new Error("Finding not found in this workspace")
    }

    return {
      id: finding.id,
      title: finding.title,
      summary: finding.summary,
      severity: finding.severity,
      status: finding.status,
      cwe: finding.cwe,
      category: finding.category,
      verified: finding.verified,
      technicalDetail: finding.technicalDetail,
      recommendedFix: finding.recommendedFix,
      targetId: finding.targetId,
      scanId: finding.scanId,
      evidence: finding.evidence,
      fixProposals: finding.fixProposals,
      retests: finding.retests,
    }
  },
}

export const explainFindingAction: AgentActionDefinition<z.infer<typeof ExplainFindingInputSchema>> = {
  name: "explain-finding",
  description: "Get a plain-language explanation of a finding, including what it is, why it matters, and how to fix it.",
  inputSchema: ExplainFindingInputSchema,
  permission: PERMISSIONS.agent.view,
  auditAction: "agent.action.explain_finding",
  auditResourceType: "finding",
  handler: async (input) => {
    const finding = await getFinding(input.findingId, input.workspaceId)
    if (!finding) {
      throw new Error("Finding not found in this workspace")
    }

    return explainFinding({
      title: finding.title,
      severity: finding.severity,
      cwe: finding.cwe,
      category: finding.category,
      technicalDetail: finding.technicalDetail,
      recommendedFix: finding.recommendedFix,
    })
  },
}
