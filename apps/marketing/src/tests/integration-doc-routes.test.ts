import { readFileSync, readdirSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { listPreferredAgents } from "@lyrashield/agent-registry"
import {
  EXPLICIT_INTEGRATION_DOC_SLUGS,
  listGeneratedIntegrationDocLastmods,
  listGeneratedIntegrationDocs,
} from "../lib/integration-doc-routes"
import { allRoutes, LEGACY_REDIRECTS } from "../../scripts/redirects-lib.mjs"

const pageDirectory = new URL("../pages/docs/integrations/", import.meta.url)
const authoredPages = readdirSync(pageDirectory)
  .filter((file) => file.endsWith(".astro") && file !== "[slug].astro")
  .map((file) => file.replace(/\.astro$/, ""))
const preferredSlugs = [...new Set(listPreferredAgents().map((agent) => agent.docsSlug))].sort()
const configPreviewClients = [
  "hermes",
  "kilo-code",
  "mimo-code",
  "cline",
  "vscode",
  "codebuff",
  "opencode",
  "antigravity",
  "copilot-cli",
  "oh-my-pi",
  "gemini-cli",
  "devin-cli",
  "roo-code",
  "zed",
]

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
    expect(authoredClientSlugs.has("pi")).toBe(true)
    expect(generated.has("pi")).toBe(false)

    const routes = new Set(allRoutes())
    for (const slug of preferredSlugs) {
      expect(routes, `missing concrete route for ${slug}`).toContain(`/docs/integrations/${slug}`)
    }
    expect(routes).not.toContain("/docs/integrations/[slug]")
    expect(routes).not.toContain("/docs/integrations/picode")
  })

  it("keeps the legacy Pi guide URL permanently pointed at the canonical guide", () => {
    const redirects = readFileSync(new URL("../../public/_redirects", import.meta.url), "utf8")
    const redirectLines = new Set(redirects.split("\n").map((line) => line.trim()))

    expect(LEGACY_REDIRECTS).toEqual([
      {
        source: "/docs/integrations/picode",
        target: "/docs/integrations/pi",
        code: "301",
      },
      {
        source: "/docs/integrations/picode/",
        target: "/docs/integrations/pi",
        code: "301",
      },
    ])
    for (const redirect of LEGACY_REDIRECTS) {
      expect(redirectLines).toContain(`${redirect.source} ${redirect.target} ${redirect.code}`)
    }
  })

  it("keeps Kiro's native Power and currently available MCP fallback distinct", () => {
    const kiroPage = readFileSync(
      new URL("../pages/docs/integrations/kiro.astro", import.meta.url),
      "utf8"
    )
    const pluginsPage = readFileSync(
      new URL("../pages/docs/integrations/agent-plugins.astro", import.meta.url),
      "utf8"
    )

    expect(kiroPage).toContain("Kiro's native Power path is the intended LyraShield integration")
    expect(kiroPage).toMatch(/Power distribution is still in\s+preparation/)
    expect(kiroPage).toContain("@lyrashield/mcp@0.2.11")
    expect(kiroPage).toContain("no public Power package to install yet")
    expect(pluginsPage).toMatch(/Kiro's\s+native Power distribution is in preparation/)
    expect(pluginsPage).toMatch(/published CLI installer prints the MCP settings fallback/)
  })

  it("pins installer examples to the published CLI and scopes them to shipped clients", () => {
    const pluginsPage = readFileSync(
      new URL("../pages/docs/integrations/agent-plugins.astro", import.meta.url),
      "utf8"
    )

    expect(pluginsPage).toContain("https://www.npmjs.com/package/lyrashield/v/0.2.13")
    for (const client of ["claude-code", "cursor", "openai-codex", "github-copilot", "kiro"]) {
      expect(pluginsPage).toContain(`npx --yes lyrashield@0.2.13 install ${client} --dry-run`)
    }
    expect(pluginsPage).toContain("npx --yes lyrashield@0.2.13 install vscode --dry-run")
    expect(pluginsPage).toContain("newer integration guides can appear")
    expect(pluginsPage).toMatch(/until an installer is included in\s+a published CLI release/)
    expect(pluginsPage).not.toMatch(/npx\s+lyrashield\s+(?:install|init|uninstall|login)/)
    expect(pluginsPage).not.toMatch(/npx\s+lyrashield@latest/)
  })

  it("holds config-file client writes and documents an in-place manual merge", () => {
    const preview = readFileSync(
      new URL("../components/integrations/CliConfigPreview.astro", import.meta.url),
      "utf8"
    )
    expect(preview).toContain("lyrashield@0.2.13")
    expect(preview).toContain("--dry-run")
    expect(preview).toContain("config-writing installers are withheld")
    expect(preview).toContain("Manually merge only the LyraShield server entry")
    expect(preview).toContain("retain comments where the format supports them")
    expect(preview).toContain("without replacing a symlink")
    expect(preview).not.toContain("run that same command without --dry-run")

    for (const agentId of configPreviewClients) {
      const page = readFileSync(
        new URL(`../pages/docs/integrations/${agentId}.astro`, import.meta.url),
        "utf8"
      )
      const scope = agentId === "cline" ? ' scope="global"' : ""
      expect(page).toContain(`<CliConfigPreview agentId="${agentId}"${scope} />`)
      expect(page).not.toMatch(/npx\s+lyrashield\s+install/)
      expect(page).not.toMatch(/writes? the correct config automatically/)
    }
  })

  it("keeps integration index setup preview-only while config writers are held", () => {
    const page = readFileSync(
      new URL("../pages/docs/integrations/index.astro", import.meta.url),
      "utf8"
    )
    expect(page).toContain("npx --yes lyrashield@0.2.13 init --dry-run")
    expect(page).toContain("config-file writes are withheld")
    expect(page).toContain("manually merge only the LyraShield server")
    expect(page).not.toMatch(/npx\s+lyrashield\s+init(?!\s+--dry-run)/)
    expect(page).not.toMatch(/writes files directly for/)
    expect(page).not.toContain("console-coding-agents.webp")
  })

  it("keeps generated guide metadata tied to its registry source and evidence", () => {
    const generated = listGeneratedIntegrationDocs()
    const generatedLastmods = listGeneratedIntegrationDocLastmods()
    expect(generated.length).toBeGreaterThan(0)
    for (const agent of generated) {
      expect(agent.source?.url ?? agent.verification.reference).toMatch(/^https:\/\//)
      expect(agent.verification.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
    expect(generatedLastmods).toEqual(
      generated.map((agent) => ({
        path: `/docs/integrations/${agent.docsSlug}`,
        date: agent.verification.checkedOn,
      }))
    )
    const astroConfig = readFileSync(new URL("../../astro.config.mjs", import.meta.url), "utf8")
    expect(astroConfig).toContain("listGeneratedIntegrationDocLastmods()")
    expect(astroConfig).toContain("map.set(path, date)")
  })
})
