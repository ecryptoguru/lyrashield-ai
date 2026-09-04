/**
 * Route enumeration for the marketing site's prerendered pages.
 *
 * Single source of truth for both the `_redirects` trailing-slash rules and the
 * tests that assert them: every function returns plain data derived from the
 * same filesystem/content sources Astro builds from, using only Node builtins
 * so it runs in a bare clone (the validate-*.mjs convention) and in vitest.
 *
 * The enumeration deliberately mirrors the sources `astro.config.mjs`'s
 * `contentLastmod()` walks and the shapes the Workers asset layer serves:
 * static pages, the blog hub and its pagination, blog posts, tag hubs,
 * comparison pages, the tools registry and the docs tree.
 */

import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const marketingRoot = join(here, "..")

/** Pages excluded from trailing-slash rules. */
const EXCLUDED_PAGES = new Set(["index", "404"])

function listDir(path) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Repository-owned content directories.
  return readdirSync(join(marketingRoot, path))
}

/**
 * Top-level pages from src/pages/*.astro (one route per file). API routes are
 * .ts endpoints and never match the .astro glob; 404 and the homepage are
 * excluded (the homepage IS its canonical form).
 */
export function topLevelPages() {
  return listDir("src/pages")
    .filter((name) => name.endsWith(".astro"))
    .map((name) => name.replace(/\.astro$/, ""))
    .filter((name) => !EXCLUDED_PAGES.has(name))
    .map((name) => `/${name}`)
    .sort()
}

/** Blog post routes from the content collection filenames. */
export function blogPosts() {
  return listDir("src/content/blog")
    .filter((name) => /\.(md|mdx)$/.test(name))
    .map((name) => `/blog/${name.replace(/\.(md|mdx)$/, "")}`)
    .sort()
}

/** Blog pagination pages: /blog is page 1; pages 2..N follow pageSize 10. */
export function blogPagination(pageSize = 10) {
  const pageCount = Math.max(1, Math.ceil(blogPosts().length / pageSize))
  const pages = []
  for (let n = 2; n <= pageCount; n += 1) pages.push(`/blog/${n}`)
  return pages
}

/** Tag hub routes from the category ids in src/lib/blog-categories.ts. */
export function tagHubs() {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Repository-owned source file.
  const source = readFileUtf8("src/lib/blog-categories.ts")
  const ids = new Set()
  const block = source.slice(
    source.indexOf("export const BLOG_CATEGORIES"),
    source.indexOf("export function", source.indexOf("export const BLOG_CATEGORIES"))
  )
  for (const match of block.matchAll(/^\s+id: "([a-z0-9-]+)",?$/gm)) ids.add(match[1])
  return [...ids].sort().map((id) => `/blog/tags/${id}`)
}

/** Comparison pages from the content collection filenames. */
export function comparePages() {
  return listDir("src/content/compare")
    .filter((name) => /\.(md|mdx)$/.test(name))
    .map((name) => `/compare/${name.replace(/\.(md|mdx)$/, "")}`)
    .sort()
}

/** Tool routes from the slug entries in src/lib/tools.ts. */
export function toolPages() {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Repository-owned source file.
  const source = readFileUtf8("src/lib/tools.ts")
  return [...source.matchAll(/^\s+slug: "([a-z0-9-]+)",?$/gm)]
    .map((match) => `/tools/${match[1]}`)
    .sort()
}

/** Docs tree routes from the .astro files under src/pages/docs (index.astro -> the folder route). */
export function docsPages() {
  const routes = []
  const walk = (dir, prefix) => {
    for (const entry of listDir(dir)) {
      const full = `${dir}/${entry}`
      if (entry.endsWith(".astro")) {
        let route = `${prefix}/${entry.replace(/\.astro$/, "")}`
        if (route.endsWith("/index")) route = route.slice(0, -"/index".length)
        routes.push(route)
      }
      // directories under docs are flat today; recurse defensively anyway
      else if (!entry.includes(".")) walk(full, `${prefix}/${entry}`)
    }
  }
  walk("src/pages/docs", "/docs")
  return routes.sort()
}

/**
 * Every prerendered HTML route that needs a trailing-slash 301 rule, in a
 * stable order. The homepage is intentionally absent: "/" is canonical.
 */
export function allRoutes() {
  return [
    ...topLevelPages(),
    "/blog",
    ...blogPagination(),
    ...blogPosts(),
    "/blog/editorial-policy",
    ...tagHubs(),
    "/compare",
    ...comparePages(),
    "/tools",
    ...toolPages(),
    ...docsPages(),
  ].sort()
}

function readFileUtf8(path) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Repository-owned source file.
  return readFileSync(join(marketingRoot, path), "utf8")
}
