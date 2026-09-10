import { PrismaClient } from "./generated/prisma"
import { env, isProd, isTest } from "@lyrashield/config"
import { prisma } from "./client"
import { createBoundedPgAdapter } from "./pool"
import { registerSlowQueryLogging } from "./slow-query-log"

const globalForSystemPrisma = globalThis as unknown as {
  systemPrisma: ReturnType<typeof createSystemPrismaClient> | undefined
}

function createSystemPrismaClient() {
  if (!env.DATABASE_SYSTEM_URL) {
    throw new Error("DATABASE_SYSTEM_URL is required for privileged system database operations")
  }
  const client = new PrismaClient({
    adapter: createBoundedPgAdapter(env.DATABASE_SYSTEM_URL),
    // Same stdout level as before (errors only), plus a query event emitter
    // consumed by the slow-query logger below; query events are never printed
    // wholesale.
    log: [
      { emit: "stdout", level: "error" },
      { emit: "event", level: "query" },
    ],
  })
  registerSlowQueryLogging(client, { scope: "db:system" })
  return client
}

/**
 * Return the narrowly scoped client for verified cross-workspace operations.
 * Production and TESTS must provide an explicit privileged URL — tests that
 * exercise a system path without one now fail loudly instead of silently
 * exercising the ordinary (RLS-extended) client and passing for the wrong
 * reason (v16 2.2). Local development without the URL still reuses the
 * ordinary client so a single-database dev setup keeps working.
 */
export function getSystemPrisma(): typeof prisma {
  if (!isProd && !isTest && !env.DATABASE_SYSTEM_URL) return prisma

  const client = globalForSystemPrisma.systemPrisma ?? createSystemPrismaClient()
  if (!globalForSystemPrisma.systemPrisma) globalForSystemPrisma.systemPrisma = client
  return client as unknown as typeof prisma
}
