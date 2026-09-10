// Fixture for rls-plain-client-scan.test.ts's self-check: this file contains
// EXACTLY the historical v16 1.4 offender shape — a FORCE-RLS model read
// through the plain client in a file with no RLS-context marker — so the
// scanner's detection can be proven. It is never imported by production code.
import { prisma } from "./client"

export async function historicalBugShape() {
  return prisma.webhookEvent.findMany({ where: { provider: "polar" } })
}
