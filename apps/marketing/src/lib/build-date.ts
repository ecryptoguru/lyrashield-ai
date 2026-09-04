/**
 * Build-time date source for JSON-LD dateModified fields, derived from the
 * last commit that touched the page's source file(s).
 *
 * IMPORTANT: the git lookup itself does NOT happen here. This module runs in
 * page frontmatter and the @astrojs/cloudflare adapter prerenders pages
 * inside workerd — where node:child_process cannot spawn git, so an
 * execSync here would silently fail on every prerendered page (exactly the
 * bug that dropped dateModified sitewide on 2026-09-03). The dates are
 * computed once in astro.config.mjs (plain Node at config-load time) and
 * injected as the __MARKETING_SOURCE_DATES__ vite define. This module only
 * reads that map.
 *
 * When a date cannot be resolved (no .git at build time or the file has no
 * commit history), this returns undefined and the caller must omit the field
 * rather than invent a date.
 */
export function buildDateFor(...paths: string[]): string | undefined {
  return __MARKETING_SOURCE_DATES__[paths.join("|")]
}
