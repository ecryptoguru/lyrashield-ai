import { pathToFileURL } from "node:url"
import {
  APPROVED_PLATFORM_ADMIN_EMAILS,
  normalizePlatformAdminEmails,
} from "../../config/src/platform-admin"

export const PLATFORM_ADMIN_APPLY_CONFIRMATION = "apply-exact-two-platform-admins"

export interface PlatformAdminCandidate {
  id: string
  email: string
  emailVerified: boolean
  twoFactorEnabled: boolean
  twoFactors: Array<{ id: string }>
  platformRole: string | null
}

export function validatePlatformAdminCandidates(
  candidates: PlatformAdminCandidate[],
  existingOperators: PlatformAdminCandidate[]
): PlatformAdminCandidate[] {
  const approved = new Set<string>(APPROVED_PLATFORM_ADMIN_EMAILS)
  const byEmail = new Map<string, PlatformAdminCandidate[]>()
  for (const candidate of candidates) {
    const email = candidate.email.trim().toLowerCase()
    const matches = byEmail.get(email) ?? []
    matches.push(candidate)
    byEmail.set(email, matches)
  }

  if (existingOperators.some((user) => !approved.has(user.email.trim().toLowerCase()))) {
    throw new Error("A non-allowlisted PLATFORM_OPERATOR already exists")
  }

  return APPROVED_PLATFORM_ADMIN_EMAILS.map((email) => {
    const matches = byEmail.get(email) ?? []
    if (matches.length !== 1) throw new Error(`Expected exactly one account for ${email}`)
    const candidate = matches[0]!
    if (!candidate.emailVerified) throw new Error(`${email} must verify email first`)
    if (!candidate.twoFactorEnabled) throw new Error(`${email} must enroll TOTP first`)
    if (candidate.twoFactors.length !== 1) {
      throw new Error(`${email} must have exactly one verified TOTP enrollment`)
    }
    if (candidate.platformRole && candidate.platformRole !== "PLATFORM_OPERATOR") {
      throw new Error(`${email} has an unsupported platform role`)
    }
    return candidate
  })
}

async function main() {
  const apply = process.argv.includes(`--apply=${PLATFORM_ADMIN_APPLY_CONFIRMATION}`)
  const configured = process.env.PLATFORM_ADMIN_EMAILS
  if (!configured) throw new Error("PLATFORM_ADMIN_EMAILS must be explicitly configured")
  normalizePlatformAdminEmails(configured)
  const databaseSystemUrl = process.env.DATABASE_SYSTEM_URL
  if (!databaseSystemUrl) {
    throw new Error("DATABASE_SYSTEM_URL is required; ordinary runtime credentials are refused")
  }

  const [{ PrismaClient }, { createBoundedPgAdapter }] = await Promise.all([
    import("../src/generated/prisma"),
    import("../src/pool"),
  ])
  const prisma = new PrismaClient({
    adapter: createBoundedPgAdapter(databaseSystemUrl),
    log: ["error"],
  })
  try {
    const candidates = await prisma.user.findMany({
      where: {
        OR: APPROVED_PLATFORM_ADMIN_EMAILS.map((email) => ({
          email: { equals: email, mode: "insensitive" as const },
        })),
      },
      select: {
        id: true,
        email: true,
        emailVerified: true,
        twoFactorEnabled: true,
        twoFactors: {
          where: { verified: true },
          select: { id: true },
          take: 2,
        },
        platformRole: true,
      },
    })
    const existingOperators = await prisma.user.findMany({
      where: { platformRole: "PLATFORM_OPERATOR" },
      select: {
        id: true,
        email: true,
        emailVerified: true,
        twoFactorEnabled: true,
        twoFactors: {
          where: { verified: true },
          select: { id: true },
          take: 2,
        },
        platformRole: true,
      },
    })
    const targets = validatePlatformAdminCandidates(candidates, existingOperators)

    if (!apply) {
      console.log(
        `Preflight passed for ${targets.length} accounts. Apply revokes all existing sessions and elevations, even when roles are already set. Re-run with --apply=${PLATFORM_ADMIN_APPLY_CONFIRMATION}.`
      )
      return
    }

    await prisma.$transaction(async (tx) => {
      for (const target of targets) {
        const updated = await tx.user.updateMany({
          where: {
            id: target.id,
            email: target.email,
            emailVerified: true,
            twoFactorEnabled: true,
            platformRole: target.platformRole,
            twoFactors: { some: { verified: true } },
          },
          data: { platformRole: "PLATFORM_OPERATOR" },
        })
        if (updated.count !== 1) throw new Error("Admin account changed during provisioning")
        await tx.platformAdminElevation.deleteMany({ where: { userId: target.id } })
        await tx.session.deleteMany({ where: { userId: target.id } })
      }
      await tx.platformAdminAudit.create({
        data: {
          actorUserId: "offline-bootstrap",
          sessionId: "offline-bootstrap",
          action: "platform_admin.bootstrap",
          resourceType: "platform_admin_set",
          metadata: { targetUserIds: targets.map((target) => target.id), count: targets.length },
        },
      })
    })
    console.log("Provisioned exactly two platform administrators with a bootstrap audit receipt.")
  } finally {
    await prisma.$disconnect()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
