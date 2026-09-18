/**
 * Social card per section.
 *
 * Every indexable page used to share `/og/og-default.png`, so a link to the
 * pricing page and a link to the WebMCP guide unfurled identically. Blog posts
 * keep their own per-post cards from the image catalogue (BlogPost.astro passes
 * `ogImage` explicitly and overrides this); `/og/og-default.png` remains the
 * fallback for routes outside the sitemap, i.e. the 404 page.
 *
 * The cards themselves are committed PNGs rendered by
 * `scripts/generate-og-cards.mjs` — a design-time tool, not a build step.
 * `scripts/crawl-built-site.mjs` asserts that no sitemap page falls back to the
 * default card.
 */
const SECTION_CARDS: ReadonlyArray<readonly [string, string]> = [
  ["/compare", "/og/compare.png"],
  ["/tools", "/og/tools.png"],
  ["/docs", "/og/docs.png"],
  ["/blog", "/og/blog.png"],
  ["/pricing", "/og/pricing.png"],
  ["/agents", "/og/agents.png"],
  ["/methodology", "/og/methodology.png"],
  ["/webmcp", "/og/webmcp.png"],
  ["/scan", "/og/scan.png"],
  ["/ai-safety", "/og/ai-safety.png"],
  ["/research", "/og/research.png"],
  ["/evidence-vault", "/og/evidence-vault.png"],
  ["/vibe-security-50", "/og/vibe-security-50.png"],
  ["/about", "/og/company.png"],
  ["/support", "/og/company.png"],
  ["/demo", "/og/company.png"],
  ["/privacy", "/og/company.png"],
  ["/security-reporting", "/og/company.png"],
]

export const DEFAULT_OG_IMAGE = "/og/og-default.png"

/** Card paths that must exist under `public/`, asserted by the gate's unit test. */
export const OG_CARD_PATHS: readonly string[] = [
  "/og/home.png",
  ...new Set(SECTION_CARDS.map(([, card]) => card)),
]

export function ogImageFor(pathname: string): string {
  if (pathname === "/") return "/og/home.png"
  for (const [prefix, card] of SECTION_CARDS) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return card
  }
  return DEFAULT_OG_IMAGE
}
