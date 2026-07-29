import { randomUUID } from "crypto"
import { prisma } from "@lyrashield/db"

const MAX_FIND_RETRIES = 10
const FIND_RETRY_MS = 25

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

  // The winning row should now be committed. In the unlikely case it is still
  // invisible to our read, retry briefly.
  for (let i = 0; i < MAX_FIND_RETRIES; i++) {
    const state = await prisma.onboardingState.findUnique({
      where: { userId },
    })
    if (state) {
      return state
    }
    await new Promise((resolve) => setTimeout(resolve, FIND_RETRY_MS))
  }

  throw new Error(`Onboarding state not found for user ${userId}`)
}
