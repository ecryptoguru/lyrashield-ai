import { createHash } from "node:crypto"
import { NextResponse } from "next/server"
import {
  buildSetupHealthSnapshot,
  type SetupHealthScope,
  type SetupHealthSnapshot,
} from "@lyrashield/types"
import { GET as legacyEligibilityGET } from "../../scans/eligibility/route"

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function sortedAttachmentFingerprint(url: URL): string | null {
  const ids = [...new Set(url.searchParams.getAll("attachmentIds"))].sort()
  return ids.length ? digest(JSON.stringify(["lyrashield-attachments/1.0.0", ...ids])) : null
}

function scopeFromRequest(url: URL): SetupHealthScope {
  const policyId = url.searchParams.get("policyId")
  const authorizationRef = url.searchParams.get("authorizationRef")
  const headRef = url.searchParams.get("headRef")
  return {
    workspaceId: url.searchParams.get("workspaceId") ?? "",
    targetId: url.searchParams.get("targetId") ?? "",
    goal: url.searchParams.get("goal") ?? "",
    mode: url.searchParams.get("mode") ?? "",
    workflow: url.searchParams.get("workflow") ?? "REVIEW_TARGET",
    policyFingerprint: policyId ? digest(`policy-id:${policyId}`) : null,
    attachmentFingerprint: sortedAttachmentFingerprint(url),
    authorizationFingerprint: authorizationRef
      ? digest(`authorization-ref:${authorizationRef}`)
      : null,
    sourceRevision: headRef && /^[a-f0-9]{40}$/i.test(headRef) ? headRef.toLowerCase() : null,
  }
}

function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", "private, no-store")
  return response
}

/**
 * Versioned, read-only setup-health projection.
 *
 * The legacy eligibility route remains the single admission evaluator. This
 * adapter preserves its exact blocker reason and invalidation checks while
 * giving web, CLI and MCP one client-neutral status/action contract.
 */
export async function GET(request: Request) {
  const legacy = await legacyEligibilityGET(request)
  const body = (await legacy.json().catch(() => null)) as
    | { success: true; data: Record<string, unknown> }
    | { success: false; error?: { code?: string; message?: string; details?: unknown } }
    | null

  if (!legacy.ok || !body || body.success !== true) {
    return noStore(
      NextResponse.json(
        body ?? {
          success: false,
          error: { code: "INVALID_RESPONSE", message: "Setup check failed" },
        },
        { status: legacy.status, headers: legacy.headers }
      )
    )
  }

  const data = body.data
  const blockers = Array.isArray(data.blockers)
    ? (data.blockers as Array<{ code?: unknown; message?: unknown }>)
    : []
  const firstBlocker = blockers[0]
  const code =
    (typeof data.code === "string" && data.code) ||
    (typeof firstBlocker?.code === "string" ? firstBlocker.code : null)
  const message =
    (typeof data.message === "string" && data.message) ||
    (typeof firstBlocker?.message === "string" ? firstBlocker.message : null)
  const limitations = Array.isArray(data.limitations)
    ? (data.limitations as unknown[]).filter((item): item is string => typeof item === "string")
    : []
  const scope = scopeFromRequest(new URL(request.url))
  const scopeFingerprint = digest(JSON.stringify(["lyrashield-setup-scope/1.0.0", scope]))
  const snapshot: SetupHealthSnapshot = buildSetupHealthSnapshot({
    allowed: data.allowed === true,
    code,
    message,
    limitations,
    scope,
    scopeFingerprint,
  })

  return noStore(NextResponse.json({ success: true, data: snapshot }))
}
