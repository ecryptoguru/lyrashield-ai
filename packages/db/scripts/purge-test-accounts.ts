// Founder-side maintenance script — NOT committed, NOT run by the agent.
// Deletes two known test accounts from PRODUCTION via the RLS-safe deletion
// path (the same one fixed in PR #223). Requires prod env (.env) with prod DB
// access. Run from the repo root:
//   pnpm --filter @lyrashield/db exec tsx --env-file=../../.env scripts/purge-test-accounts.ts
import { prisma, deleteUserAccount, getAccountDeletionPlan } from "../src/index"

const TARGETS = [
  "devagent-v12+20260807@fusionwaveai.com",
  "devagent-v10+20260801@fusionwaveai.com",
]

for (const email of TARGETS) {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } })
  if (!user) { console.log(`skip ${email}: not found (already deleted?)`); continue }

  const plan = await getAccountDeletionPlan(user.id)
  console.log(`${email}: deletable=[${plan.deletable.map(w=>w.name)}] blocked=${plan.blocked.length} retained=${plan.retained.length}`)

  // deleteUserAccount requires typing the deletable workspace names as confirmation
  const confirmation = plan.deletable.length
    ? plan.deletable.map(w=>w.name).sort().join(", ")
    : "DELETE"
  await deleteUserAccount(user.id, confirmation)
  console.log(`DELETED ${email}`)
}
await prisma.$disconnect()
