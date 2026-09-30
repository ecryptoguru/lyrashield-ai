import { readdirSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { listPreferredAgents } from "@lyrashield/agent-registry"
import {
  EXPLICIT_INTEGRATION_DOC_SLUGS,
  listGeneratedIntegrationDocs,
} from "../lib/integration-doc-routes"
import { allRoutes } from "../../scripts/redirects-lib.mjs"

const pageDirectory = new URL("../pages/docs/integrations/", import.meta.url)
const authoredPages = readdirSync(pageDirectory)
  .filter((file) => file.endsWith(".astro") && file !== "[slug].astro")
  .map((file) => file.replace(/\.astro$/, ""))
const preferredSlugs = [...new Set(listPreferredAgents().map((agent) => agent.docsSlug))].sort()

describe("integration guide routes", () => {
  it("resolves every preferred registry link to an authored or generated page", () => {
    const explicit = new Set(EXPLICIT_INTEGRATION_DOC_SLUGS)
    const generated = new Set(listGeneratedIntegrationDocs().map((agent) => agent.docsSlug))
    const authoredClientSlugs = new Set(
      authoredPages.filter((slug) => preferredSlugs.includes(slug))
    )

    expect([...authoredClientSlugs].sort()).toEqual([...explicit].sort())
    expect([...explicit].filter((slug) => generated.has(slug))).toEqual([])
    expect([...new Set([...authoredClientSlugs, ...generated])].sort()).toEqual(preferredSlugs)

    const routes = new Set(allRoutes())
    for (const slug of preferredSlugs) {
      expect(routes, `missing concrete route for ${slug}`).toContain(`/docs/integrations/${slug}`)
    }
    expect(routes).not.toContain("/docs/integrations/[slug]")
  })

  it("keeps generated guide metadata tied to its registry source and evidence", () => {
    const generated = listGeneratedIntegrationDocs()
    expect(generated.length).toBeGreaterThan(0)
    for (const agent of generated) {
      expect(agent.source?.url ?? agent.verification.reference).toMatch(/^https:\/\//)
      expect(agent.verification.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})
