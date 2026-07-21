import { randomUUID } from "node:crypto"
import { PrismaClient, Prisma } from "./generated/prisma"
import { PrismaPg } from "@prisma/adapter-pg"
import { env, isDev } from "@lyrashield/config"
import { workspaceExtension } from "./extension"
import { computeAuditHash } from "./audit-hash"

const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof createPrismaClient> | undefined
}

function createPrismaClient() {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL })
  const baseClient = new PrismaClient({
    adapter,
    log: isDev ? ["error", "warn"] : ["error"],
  })

  const prismaWithWorkspace = baseClient.$extends(workspaceExtension)

  const auditExtension = Prisma.defineExtension({
    query: {
      auditLog: {
        async create({ args }) {
          const data = (args?.data ?? {}) as Record<string, unknown>

          const workspaceId =
            (data.workspaceId as string | undefined) ??
            (data.workspace as { connect?: { id: string } } | undefined)?.connect?.id

          if (!workspaceId) {
            throw new Error("workspaceId is required for auditLog.create")
          }

          const id = (data.id as string | undefined) ?? randomUUID()
          const actorUserId = (data.actorUserId as string | null) ?? null
          const action = (data.action as string) ?? ""
          const resourceType = (data.resourceType as string) ?? ""
          const resourceId = (data.resourceId as string | null) ?? null
          const ipAddress = (data.ipAddress as string | null) ?? null
          const userAgent = (data.userAgent as string | null) ?? null
          const metadata = data.metadata ?? null

          return baseClient.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))`
            const last = await tx.auditLog.findFirst({
              where: { workspaceId },
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              select: { hash: true, createdAt: true },
            })
            const prevHash = last?.hash ?? null
            const requestedCreatedAt = (data.createdAt as Date | undefined) ?? new Date()
            // Concurrent events can land in the same millisecond. Make the
            // locked chain order explicit so `(createdAt, id)` sorting cannot
            // disagree with the predecessor chosen under the advisory lock.
            const createdAt =
              last && requestedCreatedAt <= last.createdAt
                ? new Date(last.createdAt.getTime() + 1)
                : requestedCreatedAt
            const hash = computeAuditHash(
              {
                id,
                workspaceId,
                actorUserId,
                action,
                resourceType,
                resourceId,
                ipAddress,
                userAgent,
                metadata,
                createdAt,
              },
              prevHash
            )
            const rest = Object.fromEntries(Object.entries(data).filter(([k]) => k !== "workspace"))

            return tx.auditLog.create({
              data: {
                ...rest,
                workspaceId,
                id,
                createdAt,
                prevHash,
                hash,
              } as Prisma.AuditLogUncheckedCreateInput,
            })
          })
        },
      },
    },
  })

  return prismaWithWorkspace.$extends(auditExtension)
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma
}
