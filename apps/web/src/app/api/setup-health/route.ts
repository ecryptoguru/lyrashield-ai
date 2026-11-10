import { NextResponse } from "next/server"
import { buildSetupHealthSnapshot, type SetupHealthSnapshot } from "@lyrashield/types"
import { env } from "@lyrashield/config"
import { buildSetupAuthorityProjection } from "../../../lib/setup-health-authority"
import { evaluateScanSetup } from "../scans/eligibility/evaluator"

function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", "private, no-store")
  return response
}

/**
 * Versioned, read-only setup-health projection.
 *
 * The shared eligibility evaluator supplies the decision and the authority
 * it actually observed. This projection preserves blocker reasons while
 * giving web, CLI and MCP one client-neutral status/action contract.
 */
export async function GET(request: Request) {
  const { response: legacy, evidence } = await evaluateScanSetup(request, { resolveSource: true })
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
    ? (data.blockers as Array<{ code?: unknown; message?: unknown }>).map((blocker) => ({
        code: typeof blocker?.code === "string" ? blocker.code : null,
        message: typeof blocker?.message === "string" ? blocker.message : null,
      }))
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
  const { scope, scopeFingerprint, complete } = buildSetupAuthorityProjection(
    evidence,
    env.BETTER_AUTH_SECRET
  )
  const authorityUnavailable = data.allowed === true && !complete
  if (authorityUnavailable) {
    blockers.unshift({
      code: "SETUP_AUTHORITY_UNAVAILABLE",
      message: "Setup authority could not be fully evaluated. Retry the setup check.",
    })
  } else if (!complete) {
    limitations.push("Some setup authority was not evaluated after an earlier blocker.")
  }
  const snapshot: SetupHealthSnapshot = buildSetupHealthSnapshot({
    allowed: data.allowed === true && complete,
    code: authorityUnavailable ? "SETUP_AUTHORITY_UNAVAILABLE" : code,
    message: authorityUnavailable
      ? "Setup authority could not be fully evaluated. Retry the setup check."
      : message,
    blockers,
    dependencyUnavailable: data.dependencyUnavailable === true || authorityUnavailable,
    limitations,
    scope,
    scopeFingerprint,
  })

  return noStore(NextResponse.json({ success: true, data: snapshot }))
}
