import { describe, expect, it } from "vitest"
import { buildDocsJsonLd } from "./docs-metadata"

const origin = "https://lyrashieldai.com"

describe("buildDocsJsonLd", () => {
  it("reproduces the common guide TechArticle + BreadcrumbList byte-for-byte", () => {
    // The literal every migrated guide inlined before this builder existed —
    // JSON.stringify equality pins both values and key order.
    const { canonical, jsonLd } = buildDocsJsonLd({
      origin,
      path: "/docs/integrations/claude-code",
      title: "LyraShield MCP for Claude Code — Setup Guide",
      description: "Add the LyraShield MCP server to Claude Code in under two minutes.",
      updatedDate: "2026-09-08",
      breadcrumbLabel: "Claude Code",
    })

    expect(canonical).toBe("https://lyrashieldai.com/docs/integrations/claude-code")
    expect(JSON.stringify(jsonLd)).toBe(
      JSON.stringify([
        {
          "@context": "https://schema.org",
          "@type": "TechArticle",
          headline: "LyraShield MCP for Claude Code — Setup Guide",
          description: "Add the LyraShield MCP server to Claude Code in under two minutes.",
          url: "https://lyrashieldai.com/docs/integrations/claude-code",
          dateModified: "2026-09-08",
          author: { "@id": "https://lyrashieldai.com/#organization" },
          publisher: { "@id": "https://lyrashieldai.com/#organization" },
          inLanguage: "en-US",
        },
        {
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "Home", item: "https://lyrashieldai.com/" },
            {
              "@type": "ListItem",
              position: 2,
              name: "Integrations",
              item: "https://lyrashieldai.com/docs/integrations",
            },
            {
              "@type": "ListItem",
              position: 3,
              name: "Claude Code",
              item: "https://lyrashieldai.com/docs/integrations/claude-code",
            },
          ],
        },
      ])
    )
  })

  it("keeps page-specific HowTo/FAQ entries between the common blocks", () => {
    // Guides compose the shared blocks with their own entries; ordering must
    // survive: TechArticle, page entry, BreadcrumbList.
    const { techArticle, breadcrumbList } = buildDocsJsonLd({
      origin,
      path: "/docs/integrations/kiro",
      title: "LyraShield MCP for Kiro — Setup Guide",
      description: "Add the LyraShield MCP server to Kiro.",
      updatedDate: "2026-09-08",
      breadcrumbLabel: "Kiro",
    })
    const howTo = {
      "@context": "https://schema.org",
      "@type": "HowTo",
      name: "Set up LyraShield MCP in Kiro",
      step: [{ "@type": "HowToStep", position: 1, name: "Open settings", text: "Open mcp.json." }],
    }
    const jsonLd: unknown[] = [techArticle, howTo, breadcrumbList]

    expect(jsonLd.map((entry) => (entry as Record<string, unknown>)["@type"])).toEqual([
      "TechArticle",
      "HowTo",
      "BreadcrumbList",
    ])
    expect(howTo.name).toBe("Set up LyraShield MCP in Kiro")
  })

  it("emits TechArticle only when no breadcrumb label is given", () => {
    const { canonical, jsonLd, breadcrumbList } = buildDocsJsonLd({
      origin,
      path: "/docs/integrations/aider",
      title: "LyraShield for Aider — Standalone CLI Guide",
      description: "Use LyraShield alongside Aider through the standalone CLI and CI.",
      updatedDate: "2026-09-08",
    })

    expect(canonical).toBe("https://lyrashieldai.com/docs/integrations/aider")
    expect(breadcrumbList).toBeUndefined()
    expect(jsonLd).toHaveLength(1)
    expect(jsonLd[0]?.["@type"]).toBe("TechArticle")
  })

  it("labels the middle crumb after breadcrumbSection for non-guide docs pages", () => {
    const { breadcrumbList } = buildDocsJsonLd({
      origin,
      path: "/docs/api",
      title: "LyraShield API v1 Reference",
      description: "OpenAPI 3.1 reference for the LyraShield /api/v1 endpoints.",
      updatedDate: "2026-07-31",
      breadcrumbLabel: "API v1",
      breadcrumbSection: "Docs",
    })
    const items = breadcrumbList?.itemListElement as { name: string; item: string }[]

    expect(items.map((item) => item.name)).toEqual(["Home", "Docs", "API v1"])
    // The middle crumb still links to the docs index, whatever its label.
    expect(items[1]?.item).toBe("https://lyrashieldai.com/docs/integrations")
  })
})
