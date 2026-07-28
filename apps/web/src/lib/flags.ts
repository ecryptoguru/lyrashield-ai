import { cache } from "react"
import { cookies } from "next/headers"
import { z } from "zod"
import { prisma } from "@lyrashield/db"
import type { AuthSession } from "@lyrashield/auth/server"
import { env } from "@lyrashield/config"

export const uxV2FlagNames = [
  "uxV2Shell",
  "uxV2Onboarding",
  "uxV2Runs",
  "uxV2Issues",
  "uxV2Evidence",
  "uxV2Notifications",
  "uxV2Sharing",
] as const

export const UxV2FlagsSchema = z.object({
  uxV2Shell: z.boolean().default(false),
  uxV2Onboarding: z.boolean().default(false),
  uxV2Runs: z.boolean().default(false),
  uxV2Issues: z.boolean().default(false),
  uxV2Evidence: z.boolean().default(false),
  uxV2Notifications: z.boolean().default(false),
  uxV2Sharing: z.boolean().default(false),
})

export type UxV2Flags = z.infer<typeof UxV2FlagsSchema>

const DEFAULT_FLAGS: UxV2Flags = {
  uxV2Shell: false,
  uxV2Onboarding: false,
  uxV2Runs: false,
  uxV2Issues: false,
  uxV2Evidence: false,
  uxV2Notifications: false,
  uxV2Sharing: false,
}

function allEnabled(): UxV2Flags {
  return uxV2FlagNames.reduce((acc, name) => ({ ...acc, [name]: true }), {} as UxV2Flags)
}

const CookieFlagsSchema = z.object({
  workspaceId: z.string().optional(),
  flags: UxV2FlagsSchema,
})

export const getFlags = cache(async function getFlags(
  session: AuthSession | null,
  workspace?: { id: string } | null
): Promise<UxV2Flags> {
  if (!session) return DEFAULT_FLAGS

  // 1. Env allowlist: explicit internal user IDs.
  const internalUserIds =
    env.UX_V2_INTERNAL_USER_IDS?.split(",")
      .map((id) => id.trim())
      .filter(Boolean) ?? []
  if (internalUserIds.includes(session.userId)) {
    return allEnabled()
  }

  // 2. Env allowlist: users created on or after the configured ISO date.
  if (env.UX_V2_NEW_USERS_FROM) {
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { createdAt: true },
    })
    const cutoff = new Date(env.UX_V2_NEW_USERS_FROM)
    if (user && user.createdAt >= cutoff) {
      return allEnabled()
    }
  }

  // 3. Per-workspace cookie override.
  const cookieValue = (await cookies()).get("lyrashield-uxv2-flags")?.value
  if (cookieValue) {
    try {
      const parsed = JSON.parse(decodeURIComponent(cookieValue))
      const cookie = CookieFlagsSchema.safeParse(parsed)
      if (cookie.success) {
        const matchesWorkspace =
          !cookie.data.workspaceId || cookie.data.workspaceId === workspace?.id
        if (matchesWorkspace) {
          return { ...DEFAULT_FLAGS, ...cookie.data.flags }
        }
      }
    } catch {
      // Ignore malformed cookie.
    }
  }

  return DEFAULT_FLAGS
})
