import { randomUUID } from "crypto"
import { prisma } from "@lyrashield/db"

/**
 * Ensure a user has exactly one onboarding row even when the server component
 * and the onboarding API initialize it at the same time. The raw
 * `INSERT ... ON CONFLICT DO NOTHING` avoids the Prisma `upsert` race that can
 * surface a P2002/23505 unique-constraint error under the pg driver.
 */
export async function getOrCreateOnboardingState(userId: string) {
  const id = randomUUID().replace(/-/g, "")

  // Try to create the row. If another request already created it, this is a
  // no-op and will not throw.
  await prisma.$executeRaw`
    INSERT INTO "onboarding_states" ("id", "userId", "currentStep", "completed", "skipped", "createdAt", "updatedAt")
    VALUES (${id}, ${userId}, 0, false, false, NOW(), NOW())
    ON CONFLICT ("userId") DO NOTHING
  `

  // PostgreSQL waits for a concurrent conflicting insert to commit before
  // this statement completes, and the following autocommit read sees that row.
  const state = await prisma.onboardingState.findUnique({
    where: { userId },
  })
  if (state) {
    return state
  }

  throw new Error(`Onboarding state not found for user ${userId}`)
}
