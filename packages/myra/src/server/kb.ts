/**
 * Knowledge retrieval — shared by the help tools. Searches the released
 * knowledge corpus with Postgres full-text search. The corpus is shared
 * reference data (not tenant data), so reads run unbound; audience and role
 * restrictions are enforced in the query itself.
 */
import { prisma, Prisma } from "@lyrashield/db"
import {
  isTrustedSourceUrl,
  sanitizeLinkHref,
  sanitizeMarkdown,
  stripDangerousText,
} from "../sanitize"
import type { MyraPrincipal } from "../contracts"
import type { MyraDb } from "./db"

export interface KnowledgeHit {
  entryId: string
  title: string
  snippet: string
  sourceUrl: string | null
  topic: string
  rank: number
}

/** Minimum ts_rank before a hit is shown; below it Myra abstains. */
const RANK_THRESHOLD = 0.01

export async function searchKnowledge(
  principal: MyraPrincipal,
  query: string,
  opts: { limit?: number; role?: string | null } = {},
  db: MyraDb = prisma
): Promise<KnowledgeHit[]> {
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 10)
  const trimmed = query.trim().slice(0, 300)
  if (!trimmed) return []
  // Keep exact web-search matches first, but let a few relevant terms recover
  // support questions whose conversational wording makes an all-term query empty.
  const terms = [...new Set(trimmed.match(/[a-z0-9]+/gi)?.map((word) => word.toLowerCase()) ?? [])]
  const broadQuery = terms.slice(0, 16).join(" OR ")
  if (!broadQuery) return []

  // Anonymous sees PUBLIC entries only. Authenticated users also see
  // RESTRICTED entries whose allowedRoles is empty or contains their role.
  const audienceFilter =
    principal.kind === "user"
      ? Prisma.sql`audience IN ('PUBLIC', 'RESTRICTED')`
      : Prisma.sql`audience = 'PUBLIC'`
  const roleFilter =
    principal.kind === "user" && opts.role
      ? Prisma.sql`(cardinality("allowedRoles") = 0 OR ${opts.role} = ANY("allowedRoles"))`
      : Prisma.sql`cardinality("allowedRoles") = 0`

  // The generated searchVector column (title + topic + content) is
  // maintained by Postgres and GIN-indexed — never recompute the vector
  // per query or the topic terms and the index are both lost.
  const rows = await db.$queryRaw<
    {
      id: string
      title: string
      sourceUrl: string | null
      topic: string
      snippet: string
      rank: number
    }[]
  >(Prisma.sql`
    SELECT id, title, "sourceUrl", topic,
           left(content, 400) AS snippet,
           ts_rank("searchVector", websearch_to_tsquery('english', ${broadQuery})) AS rank
    FROM myra_knowledge_entries
    WHERE status = 'ACTIVE'
      AND ${audienceFilter}
      AND ${roleFilter}
      AND "searchVector" @@ websearch_to_tsquery('english', ${broadQuery})
    ORDER BY ("searchVector" @@ websearch_to_tsquery('english', ${trimmed})) DESC, rank DESC
    LIMIT ${limit}
  `)
  return rows
    .filter((r) => Number(r.rank) >= RANK_THRESHOLD)
    .map((r) => {
      // Corpus text is untrusted: degrade markup to plain text and drop
      // source URLs outside the product's own surface.
      const sourceUrl =
        r.sourceUrl && isTrustedSourceUrl(r.sourceUrl) ? sanitizeLinkHref(r.sourceUrl) : null
      const toText = (raw: string) =>
        stripDangerousText(
          sanitizeMarkdown(raw)
            .map((s) => s.text)
            .join("")
        )
      return {
        entryId: r.id,
        title: toText(r.title).slice(0, 160),
        snippet: toText(r.snippet).slice(0, 400),
        sourceUrl,
        topic: r.topic,
        rank: Number(r.rank),
      }
    })
}

/** Withdraw a bad entry immediately (operator/system path). */
export async function withdrawEntry(entryId: string, db: MyraDb = prisma): Promise<boolean> {
  const res = await db.myraKnowledgeEntry.updateMany({
    where: { id: entryId, status: "ACTIVE" },
    data: { status: "WITHDRAWN" },
  })
  return res.count === 1
}

/** Entries due for human review (reviewAfter elapsed). */
export async function listReviewQueue(
  opts: { limit?: number } = {},
  db: MyraDb = prisma
): Promise<{ id: string; title: string; topic: string; reviewAfter: Date | null }[]> {
  return db.myraKnowledgeEntry.findMany({
    where: { status: "ACTIVE", reviewAfter: { lte: new Date() } },
    orderBy: { reviewAfter: "asc" },
    take: Math.min(opts.limit ?? 50, 200),
    select: { id: true, title: true, topic: true, reviewAfter: true },
  })
}
