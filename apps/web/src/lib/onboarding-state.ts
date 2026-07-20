import { prisma } from "@lyrashield/db"

function isUniqueConstraintError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002"
}

/**
 * Ensures a user has one onboarding row even when the server component and
 * onboarding API initialize it at the same time. Prisma's upsert can surface
 * P2002 during that race with the PostgreSQL adapter, so read the winning row
 * rather than treating a concurrent first request as an application error.
 */
export async function getOrCreateOnboardingState(userId: string) {
  try {
    return await prisma.onboardingState.upsert({
      where: { userId },
      create: { userId },
      update: {},
    })
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error
    }

    const state = await prisma.onboardingState.findUnique({
      where: { userId },
    })

    if (state) {
      return state
    }

    // The database adapter only reports P2002 after the competing insert has
    // committed. Keep a narrowly-scoped retry for drivers with weaker timing.
    return prisma.onboardingState.upsert({
      where: { userId },
      create: { userId },
      update: {},
    })
  }
}
