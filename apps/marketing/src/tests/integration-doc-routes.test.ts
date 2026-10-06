import { readFileSync, readdirSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  getAgent,
  getPublishedCliInstallCommand,
  listPreferredAgents,
} from "@lyrashield/agent-registry"
import {
  EXPLICIT_INTEGRATION_DOC_SLUGS,
  listGeneratedIntegrationDocLastmods,
  listGeneratedIntegrationDocs,
} from "../lib/integration-doc-routes"
import { allRoutes, LEGACY_REDIRECTS } from "../../scripts/redirects-lib.mjs"

const pageDirectory = new URL("../pages/docs/integrations/", import.meta.url)
const userGuide = readFileSync(new URL("../../../../docs/user-guide.md", import.meta.url), "utf8")
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
  it("points the user guide at the registry-derived integration directory", () => {
    expect(userGuide).toMatch(/\[client-specific setup guides\]\(\/docs\/integrations\)/)
  })

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

    // The legacy region also carries the Wave 8 compare-consolidation redirects
    // (both the slashless and the trailing-slash form of each retired
    // -vs-lyrashield post). Assert the Pi pair is present and correct rather
    // than pinning the whole array, so adding a legacy redirect elsewhere does
    // not break an unrelated guide assertion.
    expect(LEGACY_REDIRECTS).toEqual(
      expect.arrayContaining([
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
    )
    for (const redirect of LEGACY_REDIRECTS) {
      expect(redirectLines).toContain(`${redirect.source} ${redirect.target} ${redirect.code}`)
    }
  })

  it("keeps Kiro's native Power listing and MCP fallback distinct", () => {
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
    expect(kiroPage).toContain("@lyrashield/mcp@0.2.12")
    expect(kiroPage).toContain("no public Power package to install yet")
    expect(pluginsPage).toMatch(/Kiro's\s+native Power distribution is in preparation/)
    expect(pluginsPage).toMatch(/guide\s+documents the MCP settings fallback/)
  })

  it("documents Bolt's current remote Connector flow and LyraShield auth boundary", () => {
    const remotePage = readFileSync(
      new URL("../pages/docs/integrations/remote-mcp.astro", import.meta.url),
      "utf8"
    )

    expect(remotePage).toMatch(/Settings → Connectors →\s+Manage connectors/)
    expect(remotePage).toContain("custom Connector")
    expect(remotePage).toContain("Bolt supports HTTP and SSE")
    expect(remotePage).toContain("LyraShield uses Streamable HTTP")
    expect(remotePage).toContain("if Bolt offers OAuth for this Connector")
    expect(remotePage).toContain("https://bolt.new/blog/introducing-connectors")
    expect(remotePage).toContain("mutating calls return")
    expect(remotePage).toContain("connect_required")
    expect(remotePage).toContain("read tools only")
    expect(remotePage).not.toContain("Bolt.new Desktop")
  })

  it("pins installer examples to the coordinated CLI and keeps marketplace status separate", () => {
    const pluginsPage = readFileSync(
      new URL("../pages/docs/integrations/agent-plugins.astro", import.meta.url),
      "utf8"
    )

    expect(pluginsPage).toContain("https://www.npmjs.com/package/lyrashield/v/0.2.14")
    for (const client of ["claude-code", "cursor", "openai-codex", "github-copilot"]) {
      expect(pluginsPage).not.toContain(`npx --yes lyrashield@0.2.14 install ${client} --dry-run`)
    }
    expect(pluginsPage).toContain("npx --yes lyrashield@0.2.14 install vscode --dry-run")
    expect(pluginsPage).toContain("npx --yes lyrashield@0.2.14 install vscode</code>")
    expect(pluginsPage).toContain("marketplace listings remain pending review and public readback")
    expect(pluginsPage).not.toMatch(/npx\s+lyrashield\s+(?:install|init|uninstall|login)/)
    expect(pluginsPage).not.toMatch(/npx\s+lyrashield@latest/)
  })

  it("distinguishes Codebuff direct MCP from the unpublished read-only reviewer", () => {
    const guide = readFileSync(
      new URL("../pages/docs/integrations/codebuff.astro", import.meta.url),
      "utf8"
    )
    expect(guide).toContain(".agents/mcp.json")
    expect(guide).toContain("@lyrashield/mcp@0.2.12")
    expect(guide).toContain("static HTTP headers")
    expect(guide).not.toContain("Remote OAuth needs no local key")
    const manual = readFileSync(new URL("../../../../docs/user-guide.md", import.meta.url), "utf8")
    expect(manual).toContain("separate native reviewer adapter is read-only")
    expect(manual).toContain("supports project `.agents/mcp.json`")
    expect(manual).not.toContain("does not use the previously claimed `.agents/mcp.json`")
  })

  it("offers only exact CLI config installers and preserves the manual fallback", () => {
    const preview = readFileSync(
      new URL("../components/integrations/CliConfigPreview.astro", import.meta.url),
      "utf8"
    )
    expect(preview).toContain("getPublishedCliInstallCommand")
    expect(preview).toContain("lyrashield@0.2.14 login --oauth")
    expect(preview).toContain("--dry-run")
    expect(preview).toContain("No matching CLI installer is recorded")
    expect(preview).toContain("preserving existing servers, comments")
    for (const id of ["vscode", "opencode", "gemini-cli", "copilot-cli"]) {
      expect(getPublishedCliInstallCommand(getAgent(id)!)).toBe(
        `npx -y lyrashield@0.2.14 install ${id}`
      )
    }
    for (const id of ["cursor", "openai-codex", "picode"]) {
      expect(getPublishedCliInstallCommand(getAgent(id)!)).toBeNull()
    }

    for (const agentId of configPreviewClients) {
      const page = readFileSync(
        new URL(`../pages/docs/integrations/${agentId}.astro`, import.meta.url),
        "utf8"
      )
      const scope = agentId === "cline" ? ' scope="global"' : ""
      expect(page).toContain(`<CliConfigPreview agentId="${agentId}"${scope} />`)
      expect(page).not.toMatch(/writes? the correct config automatically/)
    }
  })

  it("describes CLI writing as client-specific and keeps direct MCP setup available", () => {
    const page = readFileSync(
      new URL("../pages/docs/integrations/index.astro", import.meta.url),
      "utf8"
    )
    expect(page).not.toContain("init --dry-run")
    expect(page).toContain("CLI 0.2.14")
    expect(page).toContain("client has one documented LyraShield skill path")
    expect(page).toContain("merge the LyraShield entry manually")
    expect(page).not.toMatch(/npx\s+lyrashield\s+init(?!\s+--dry-run)/)
    expect(page).not.toMatch(/writes files directly for/)
    expect(page).not.toContain("console-coding-agents.webp")
  })

  it("documents Pi's native OAuth and pinned shared-skill installer without implying a listing", () => {
    const page = readFileSync(
      new URL("../pages/docs/integrations/pi.astro", import.meta.url),
      "utf8"
    )
    expect(page).toContain("pi mcp login lyrashield")
    expect(page).toContain("lyrashield@0.2.14 skills install pi --dry-run")
    expect(page).toContain("does not imply a public Pi listing")
    expect(page).not.toContain("skills installer remain pending release")
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
