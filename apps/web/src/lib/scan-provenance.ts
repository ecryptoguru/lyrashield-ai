import { buildPublicScanExecutionPlan, PublicScanExecutionPlanSchema } from "@lyrashield/types"
import { canonicalizeJson, sha256Sync } from "@lyrashield/security/webmcp"

/** The public digest binds only public fields; private limits remain worker-owned. */
export function publicScanProvenance(raw: unknown) {
  const publicPlan = PublicScanExecutionPlanSchema.safeParse(raw)
  const executionPlan =
    buildPublicScanExecutionPlan(raw) ?? (publicPlan.success ? publicPlan.data : null)
  return {
    executionPlan,
    executionPlanHash: executionPlan ? sha256Sync(canonicalizeJson(executionPlan)) : null,
  }
}

/** Replays may contain receipts written before the public projection existed. */
export function publicScanResult<T extends Record<string, unknown>>(
  result: T
): Omit<T, "executionPlan" | "executionPlanHash"> & ReturnType<typeof publicScanProvenance> {
  return { ...result, ...publicScanProvenance(result.executionPlan) }
}
