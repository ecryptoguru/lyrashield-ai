import { AI_BUILT_FAILURE_TAXONOMY, AI_BUILT_TAXONOMY_VERSION } from "@lyrashield/security"

export const dynamic = "force-static"

/**
 * GET /api/taxonomy/ai-built-failures
 *
 * The public, citable reference for the LyraShield AI-Built Failure Taxonomy.
 * Read-only and static — the taxonomy is a versioned public document, the
 * specialization moat in concrete form. It describes WHAT classes we test for;
 * it carries no benchmark or detection-rate claims (that discipline is enforced
 * by the catalog's own test).
 */
export async function GET() {
  return Response.json(
    {
      version: AI_BUILT_TAXONOMY_VERSION,
      issuer: "LyraShield AI",
      classes: AI_BUILT_FAILURE_TAXONOMY.map((c) => ({
        id: c.id,
        title: c.title,
        description: c.description,
        whyAiBuilt: c.whyAiBuilt,
        severity: c.severity,
        coveredBy: c.coveredBy,
        controlIds: c.controlIds,
      })),
    },
    {
      headers: {
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
        "Content-Type": "application/json; charset=utf-8",
      },
    }
  )
}
