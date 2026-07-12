import { NextResponse } from "next/server"
import { prisma } from "@lyrashield/db"
import { getRedis } from "@lyrashield/integrations"
import { logger } from "@lyrashield/logger"

export const dynamic = "force-dynamic"

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("Readiness timed out")), ms))
}

export async function GET() {
  const redis = getRedis()
  if (!redis) {
    return NextResponse.json(
      { status: "not_ready", checks: { database: false, redis: false } },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    )
  }

  const [database, redisCheck] = await Promise.allSettled([
    Promise.race([prisma.$queryRaw`SELECT 1`, timeout(2_000)]),
    Promise.race([redis.ping(), timeout(2_000)]),
  ])
  const checks = {
    database: database.status === "fulfilled",
    redis: redisCheck.status === "fulfilled",
  }
  const ready = checks.database && checks.redis

  if (!ready) logger.error("Readiness check failed", checks)
  return NextResponse.json(
    { status: ready ? "ready" : "not_ready", checks },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } }
  )
}
