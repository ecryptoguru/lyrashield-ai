import { NextResponse } from "next/server"
import { assertScanWorkerAvailable, ScanWorkerUnavailableError } from "@lyrashield/integrations"
import { logger } from "@lyrashield/logger"

export const dynamic = "force-dynamic"

export async function GET() {
  let ready = true
  try {
    await assertScanWorkerAvailable()
  } catch (error) {
    if (!(error instanceof ScanWorkerUnavailableError)) throw error
    ready = false
    logger.warn("Scan service readiness check failed", { ready: false })
  }

  return NextResponse.json(
    { status: ready ? "ready" : "not_ready", checks: { worker: ready } },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } }
  )
}
