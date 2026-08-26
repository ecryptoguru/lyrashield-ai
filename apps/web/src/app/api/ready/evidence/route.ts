import { NextResponse } from "next/server"
import { assertEvidenceStorageConfigured } from "@lyrashield/evidence-storage"
import { logger } from "@lyrashield/logger"

export const dynamic = "force-dynamic"

export async function GET() {
  let evidence = true
  try {
    assertEvidenceStorageConfigured()
  } catch {
    evidence = false
  }

  if (!evidence) logger.error("Evidence storage readiness check failed", { evidence })
  return NextResponse.json(
    { status: evidence ? "ready" : "not_ready", checks: { evidence } },
    { status: evidence ? 200 : 503, headers: { "Cache-Control": "no-store" } }
  )
}
