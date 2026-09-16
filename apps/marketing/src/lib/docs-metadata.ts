/**
 * Shared JSON-LD for the docs guides. Every guide emits the same TechArticle
 * block and most emit the same Home → section → guide BreadcrumbList; keeping
 * one builder means a schema.org field change lands on every guide at once.
 *
 * The builder also returns the canonical URL it baked into the structured
 * data so the layout's <link rel="canonical"> and the JSON-LD url/breadcrumb
 * item can never drift onto different origins or paths.
 */
export interface DocsJsonLdInput {
  /** Site origin, e.g. `Astro.site?.origin || "http://localhost:4321"`. */
  origin: string
  /** Canonical path beginning with "/", e.g. "/docs/integrations/cursor". */
  path: string
  /** TechArticle headline — the guide title without the " | LyraShield AI" suffix. */
  title: string
  description: string
  /** ISO date for dateModified, e.g. "2026-09-08". */
  updatedDate: string
  /**
   * Name of the final breadcrumb item (the current guide). Omit when the page
   * ships no BreadcrumbList.
   */
  breadcrumbLabel?: string
  /**
   * Middle breadcrumb item name; the item always links to /docs/integrations,
   * which is the canonical docs index. Defaults to "Integrations".
   */
  breadcrumbSection?: string
}

export interface DocsJsonLd {
  /** Absolute canonical URL for the layout's canonical link. */
  canonical: string
  techArticle: Record<string, unknown>
  /** Present only when `breadcrumbLabel` was provided. */
  breadcrumbList: Record<string, unknown> | undefined
  /** `[techArticle, breadcrumbList?]`, ready for the layout's jsonLd prop. */
  jsonLd: Record<string, unknown>[]
}

export function buildDocsJsonLd(input: DocsJsonLdInput): DocsJsonLd {
  const canonical = new URL(input.path, input.origin).toString()
  const techArticle: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: input.title,
    description: input.description,
    url: canonical,
    dateModified: input.updatedDate,
    author: { "@id": `${input.origin}/#organization` },
    publisher: { "@id": `${input.origin}/#organization` },
    inLanguage: "en-US",
  }
  if (input.breadcrumbLabel === undefined) {
    return { canonical, techArticle, breadcrumbList: undefined, jsonLd: [techArticle] }
  }
  const breadcrumbList: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${input.origin}/` },
      {
        "@type": "ListItem",
        position: 2,
        name: input.breadcrumbSection ?? "Integrations",
        item: `${input.origin}/docs/integrations`,
      },
      { "@type": "ListItem", position: 3, name: input.breadcrumbLabel, item: canonical },
    ],
  }
  return { canonical, techArticle, breadcrumbList, jsonLd: [techArticle, breadcrumbList] }
}
