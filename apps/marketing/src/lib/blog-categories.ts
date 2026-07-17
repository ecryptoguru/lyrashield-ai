import { getCollection, type CollectionEntry } from "astro:content"

/**
 * Blog category taxonomy.
 *
 * The six `tags` enum values in the blog content collection (see
 * src/content.config.ts) are treated as first-class categories. Each category
 * gets a stable human-facing label, a one-sentence description, and a themed
 * eyebrow used on category cards and hub pages.
 *
 * Canonical hub URL for a category is `/blog/tags/<id>` — the tag ids are
 * already URL-safe slugs, and the existing tag routes stay the single
 * canonical page per category (no duplicate `/blog/categories/*` surface).
 */

type BlogEntry = CollectionEntry<"blog">

/** Union of the six tag slugs, derived from the content collection schema. */
export type CategoryId = BlogEntry["data"]["tags"][number]

export interface BlogCategory {
  id: CategoryId
  label: string
  description: string
  /** Short themed descriptor rendered as a mono eyebrow on cards/hubs. */
  eyebrow: string
}

export const BLOG_CATEGORIES: readonly BlogCategory[] = [
  {
    id: "vibe-coding-security",
    label: "Vibe-Coding Security",
    description:
      "Practical security habits for builders shipping apps written largely by AI coding tools.",
    eyebrow: "Builder workflows",
  },
  {
    id: "access-control",
    label: "Access Control",
    description:
      "Authentication, authorization, row-level security, and sessions — keeping the wrong people away from the right data.",
    eyebrow: "Identity & data boundaries",
  },
  {
    id: "web-security",
    label: "Web Security",
    description:
      "Headers, CORS, injection, and the rest of the browser-facing attack surface of a modern web app.",
    eyebrow: "Browser attack surface",
  },
  {
    id: "supply-chain",
    label: "Supply Chain",
    description:
      "Dependencies, packages, CI/CD, and third-party services — securing the code you didn't write yourself.",
    eyebrow: "Dependencies & pipelines",
  },
  {
    id: "agent-security",
    label: "Agent Security",
    description:
      "Permissions, prompt injection, sandboxing, and guardrails for coding agents and agent-native applications.",
    eyebrow: "Autonomy & guardrails",
  },
  {
    id: "verification",
    label: "Verification",
    description:
      "Checking that findings are real and fixes actually hold: evidence, retesting, and honest security claims.",
    eyebrow: "Evidence & retesting",
  },
]

const categoriesById = new Map<string, BlogCategory>(
  BLOG_CATEGORIES.map((category) => [category.id, category])
)

/** Look up a category by its slug. Returns undefined for unknown slugs. */
export function getCategory(slug: string): BlogCategory | undefined {
  return categoriesById.get(slug)
}

/** Human label for a tag slug, falling back to the raw slug. */
export function getCategoryLabel(slug: string): string {
  return categoriesById.get(slug)?.label ?? slug
}

/** Canonical hub URL for a category (the existing tag route). */
export function categoryHref(id: CategoryId): string {
  return `/blog/tags/${id}`
}

/** All published (non-draft) posts, newest first. */
export async function getPublishedPosts(): Promise<BlogEntry[]> {
  const posts = await getCollection("blog", (entry) => !entry.data.draft)
  return posts.sort((a, b) => b.data.pubDate.getTime() - a.data.pubDate.getTime())
}

/** Published posts belonging to a category, newest first. */
export async function getPostsForCategory(id: CategoryId): Promise<BlogEntry[]> {
  const posts = await getPublishedPosts()
  return posts.filter((post) => post.data.tags.includes(id))
}

export interface BlogCategoryWithCount extends BlogCategory {
  count: number
}

/**
 * All six categories with published post counts, computed from the full
 * published set (never from a single pagination window). Categories with
 * zero posts are still returned so every hub stays discoverable.
 */
export async function getCategoriesWithCounts(): Promise<BlogCategoryWithCount[]> {
  const posts = await getPublishedPosts()
  return BLOG_CATEGORIES.map((category) => ({
    ...category,
    count: posts.filter((post) => post.data.tags.includes(category.id)).length,
  }))
}
