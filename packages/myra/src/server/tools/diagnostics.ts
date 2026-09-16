/**
 * Dashboard diagnostics — minimal status only. get_scan_status returns the
 * latest scan's status/finishedAt/verdict; never findings content.
 * get_connection_health returns integration type/status; never credentials.
 */
import { z } from "zod"
import { withWorkspaceRLS } from "@lyrashield/db"
import { err } from "../errors"
import type { MyraToolContext, MyraToolResult } from "./types"

export const getScanStatusInput = z.object({}).strict()
export const getConnectionHealthInput = z.object({}).strict()

function requireWorkspace(ctx: MyraToolContext): { accountId: string; workspaceId: string } {
  if (ctx.principal.kind !== "user") throw err("UNAUTHORIZED", "Sign in to check workspace status.")
  if (!ctx.workspaceId) {
    throw err("FORBIDDEN", "No active workspace. Pick a workspace first.")
  }
  return { accountId: ctx.principal.accountId, workspaceId: ctx.workspaceId }
}

export async function runGetScanStatus(
  ctx: MyraToolContext,
  _input: unknown
): Promise<MyraToolResult> {
  const { accountId, workspaceId } = requireWorkspace(ctx)
  const result = await withWorkspaceRLS(
    workspaceId,
    async (tx) => {
      const scan = await tx.scan.findFirst({
        where: { workspaceId, deletedAt: null },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true, status: true, endedAt: true, mode: true, createdAt: true },
      })
      if (!scan) return { scan: null, verdict: null }
      const verdict = await tx.gateVerdict.findFirst({
        where: { workspaceId, scanId: scan.id },
        orderBy: [{ evaluatedAt: "desc" }, { id: "desc" }],
        select: { state: true, evaluatedAt: true },
      })
      return { scan, verdict }
    },
    { accountId }
  )
  return {
    data: {
      checkedAt: new Date().toISOString(),
      scan: result.scan
        ? {
            status: result.scan.status,
            finishedAt: result.scan.endedAt?.toISOString() ?? null,
            mode: result.scan.mode,
          }
        : null,
      verdict: result.verdict?.state ?? null,
    },
  }
}

export async function runGetConnectionHealth(
  ctx: MyraToolContext,
  _input: unknown
): Promise<MyraToolResult> {
  const { accountId, workspaceId } = requireWorkspace(ctx)
  const rows = await withWorkspaceRLS(
    workspaceId,
    (tx) =>
      tx.integration.findMany({
        where: { workspaceId, deletedAt: null },
        select: { type: true, status: true, updatedAt: true },
        orderBy: { type: "asc" },
      }),
    { accountId }
  )
  const connections = rows.map((r) => ({ type: r.type, status: r.status }))
  const unhealthy = rows.filter((r) => r.status !== "active").length
  return {
    data: {
      checkedAt: new Date().toISOString(),
      connections,
      total: connections.length,
      unhealthy,
    },
  }
}
