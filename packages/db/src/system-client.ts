import { PrismaClient } from "./generated/prisma"
import { PrismaPg } from "@prisma/adapter-pg"
import { env, isProd } from "@lyrashield/config"
import { prisma } from "./client"

const globalForSystemPrisma = globalThis as unknown as {
  systemPrisma: ReturnType<typeof createSystemPrismaClient> | undefined
}

function createSystemPrismaClient() {
  if (!env.DATABASE_SYSTEM_URL) {
    throw new Error("DATABASE_SYSTEM_URL is required for privileged system database operations")
  }
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_SYSTEM_URL }),
    log: ["error"],
  })
}

/**
 * Return the narrowly scoped client for verified cross-workspace operations.
 * Tests and local development reuse the ordinary client; production must
 * provide an explicit privileged URL and never silently falls back.
 */
export function getSystemPrisma(): typeof prisma {
  if (!isProd && !env.DATABASE_SYSTEM_URL) return prisma

  const client = globalForSystemPrisma.systemPrisma ?? createSystemPrismaClient()
  if (!globalForSystemPrisma.systemPrisma) globalForSystemPrisma.systemPrisma = client
  return client as unknown as typeof prisma
}
