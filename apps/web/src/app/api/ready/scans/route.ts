import { NextResponse } from "next/server"
import { isScanWorkerAvailable } from "@lyrashield/integrations"
import { logger } from "@lyrashield/logger"

export const dynamic = "force-dynamic"

export async function GET() {
  const worker = await isScanWorkerAvailable()
  if (!worker) logger.warn("Scan service readiness check failed", { worker: false })

  return NextResponse.json(
    { status: worker ? "ready" : "not_ready", checks: { worker } },
    { status: worker ? 200 : 503, headers: { "Cache-Control": "no-store" } }
  )
}
