import { PrismaClient } from "./generated/prisma"
import { PrismaPg } from "@prisma/adapter-pg"
import { env, isDev } from "@lyrashield/config"
import { workspaceExtension } from "./extension"

const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof createPrismaClient> | undefined
}

function createPrismaClient() {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL })
  return new PrismaClient({
    adapter,
    log: isDev ? ["error", "warn"] : ["error"],
  }).$extends(workspaceExtension)
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma
}
