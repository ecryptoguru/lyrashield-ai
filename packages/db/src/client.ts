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
        async create({ args, query }) {
          const data = (args?.data ?? {}) as Record<string, unknown>

          const workspaceId =
            (data.workspaceId as string | undefined) ??
            (data.workspace as { connect?: { id: string } } | undefined)?.connect?.id

          if (!workspaceId) {
            throw new Error("workspaceId is required for auditLog.create")
          }

          const id = (data.id as string | undefined) ?? randomUUID()
          const createdAt = (data.createdAt as Date | undefined) ?? new Date()
          const actorUserId = (data.actorUserId as string | null) ?? null
          const action = (data.action as string) ?? ""
          const resourceType = (data.resourceType as string) ?? ""
          const resourceId = (data.resourceId as string | null) ?? null
          const ipAddress = (data.ipAddress as string | null) ?? null
          const userAgent = (data.userAgent as string | null) ?? null
          const metadata = data.metadata ?? null

          const last = await prismaWithWorkspace.auditLog.findFirst({
            where: { workspaceId },
            orderBy: { createdAt: "desc" },
            select: { hash: true },
          })

          const prevHash = last?.hash ?? null
          const chainFields = {
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
          }
          const hash = computeAuditHash(chainFields, prevHash)

          // Strip the relation form (workspace) and write using the unchecked form
          // so the hash/id/createdAt/prevHash fields are accepted unambiguously.
          const rest = Object.fromEntries(Object.entries(data).filter(([k]) => k !== "workspace"))
          const newData = {
            ...rest,
            workspaceId,
            id,
            createdAt,
            prevHash,
            hash,
          }

          return query({ ...args, data: newData } as typeof args)
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
