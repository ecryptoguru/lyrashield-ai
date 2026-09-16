/**
 * search_public_help + instant_suggest — retrieval over the released
 * knowledge corpus. Abstains (empty hits) below the rank threshold; never
 * fabricates an answer.
 */
import { z } from "zod"
import { prisma } from "@lyrashield/db"
import { sanitizeLinkHref, sanitizeMarkdown, stripDangerousText } from "../../sanitize"
import { searchKnowledge } from "../kb"
import type { MyraToolContext, MyraToolResult } from "./types"

export const searchPublicHelpInput = z.object({
  query: z.string().min(2).max(300),
  limit: z.number().int().min(1).max(5).optional(),
})

export const instantSuggestInput = z.object({
  text: z.string().min(2).max(300),
})

export async function runSearchPublicHelp(
  ctx: MyraToolContext,
  input: unknown
): Promise<MyraToolResult> {
  const { query, limit } = searchPublicHelpInput.parse(input)
  const hits = await searchKnowledge(
    ctx.principal,
    query,
    { limit: limit ?? 5, role: ctx.role },
    ctx.db ?? prisma
  )
  return {
    data: {
      hits,
      hitCount: hits.length,
      // Explicit abstention signal for the loop — no hidden fallback.
      abstained: hits.length === 0,
    },
  }
}

/** Strip markdown to plain text — suggestion snippets must never carry markup. */
function plainSnippet(raw: string): string {
  const text = sanitizeMarkdown(raw, 400)
    .map((s) => s.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim()
  return stripDangerousText(text).slice(0, 400)
}

export async function runInstantSuggest(
  ctx: MyraToolContext,
  input: unknown
): Promise<MyraToolResult> {
  const { text } = instantSuggestInput.parse(input)
  const hits = await searchKnowledge(
    ctx.principal,
    text,
    { limit: 3, role: ctx.role },
    ctx.db ?? prisma
  )
  const suggestions = hits.flatMap((h) => {
    // Never emit an unsanitized URL or markup to the client (adv-19).
    const sourceUrl = h.sourceUrl ? (sanitizeLinkHref(h.sourceUrl) ?? undefined) : undefined
    return [
      {
        entryId: h.entryId,
        title: plainSnippet(h.title).slice(0, 160),
        snippet: plainSnippet(h.snippet),
        sourceUrl,
      },
    ]
  })
  return {
    data: { hitCount: suggestions.length, abstained: suggestions.length === 0 },
    components: suggestions.length > 0 ? [{ type: "instant_suggestions", suggestions }] : [],
  }
}
