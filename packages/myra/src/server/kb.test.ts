import "./test-env"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"

/**
 * Knowledge-search tests — real Postgres under the restricted NOBYPASSRLS
 * runtime role (RLS_RUNTIME_DATABASE_URL). The corpus is shared reference
 * data: SELECT is open to every context, inserts are the unbound internal
 * path, so the restricted client both seeds and reads.
 *
 * The v18 defect: searchKnowledge recomputed
 * to_tsvector('english', title || ' ' || content) instead of using the
 * stored, GIN-indexed searchVector — which the migration builds over title,
 * topic AND content — so a term that only appears in the topic never
 * matched and every query re-derived the vector. Skips loudly when
 * RLS_RUNTIME_DATABASE_URL is absent.
 */
import { createBoundedPgAdapter } from "@lyrashield/db"
import { PrismaClient } from "@lyrashield/db/src/generated/prisma"
import type { MyraPrincipal } from "../contracts"
import type { MyraDb } from "./db"
import { searchKnowledge } from "./kb"

const runtimeUrl = process.env.RLS_RUNTIME_DATABASE_URL
if (!runtimeUrl) {
  console.warn(
    "[kb.test] SKIPPED: RLS_RUNTIME_DATABASE_URL is not set. These assertions run " +
      "against real Postgres; provide a NOBYPASSRLS connection string to exercise them."
  )
}

const runtime = runtimeUrl
  ? new PrismaClient({ adapter: createBoundedPgAdapter(runtimeUrl) })
  : null

const suffix = randomUUID().replace(/-/g, "").slice(0, 12)
const releaseId = `kb-release-${suffix}`
const topicEntryId = `kb-topic-${suffix}`
/** A lexeme that appears only in the seeded entry's topic column. */
const TOPIC_ONLY_TERM = "kaleidoscope"

const anonymous: MyraPrincipal = {
  kind: "anonymous",
  publicSessionId: `kb-anon-${suffix}`,
}

describe.skipIf(!runtimeUrl || !runtime)("knowledge search hits the stored searchVector", () => {
  beforeAll(async () => {
    if (!runtime) return
    const [role] = await runtime.$queryRaw<
      Array<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>
    >`SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`
    expect(role).toMatchObject({ rolbypassrls: false, rolsuper: false })

    await runtime.myraKnowledgeRelease.create({
      data: { id: releaseId, version: `kb-test-${suffix}` },
    })
    // The matching term lives ONLY in the topic column — title and content
    // never mention it.
    await runtime.myraKnowledgeEntry.create({
      data: {
        id: topicEntryId,
        releaseId,
        sourceId: "kb-test",
        topic: TOPIC_ONLY_TERM,
        title: "Reconnect a paused agent connection",
        content: "Open the integration card and choose reconnect to resume checks.",
        allowedRoles: [],
      },
    })
    // 1,000 filler rows make the index/seq-scan choice a real one. The ids
    // are generated here (alphanumeric + dashes) — interpolation is safe.
    await runtime.$executeRawUnsafe(`
      INSERT INTO "myra_knowledge_entries"
        ("id", "releaseId", "sourceId", "topic", "title", "content", "allowedRoles", "updatedAt")
      SELECT
        'kb-fill-${suffix}-' || g,
        '${releaseId}',
        'kb-test',
        'filler',
        'Filler entry ' || g,
        'Filler body about scan scheduling retries and connection state ' || g,
        '{}',
        now()
      FROM generate_series(1, 1000) AS g
    `)
  })

  afterAll(async () => {
    if (!runtime) return
    // The release cascades to its entries.
    await runtime.myraKnowledgeRelease.delete({ where: { id: releaseId } }).catch(() => {})
    await runtime.$disconnect()
  })

  it("returns an entry whose only matching word is in the topic column", async () => {
    const hits = await searchKnowledge(anonymous, TOPIC_ONLY_TERM, {}, runtime as never)
    expect(hits.map((h) => h.entryId)).toContain(topicEntryId)
  })

  it("emits SQL against the stored searchVector column", async () => {
    let captured = ""
    const spyDb = {
      $queryRaw: (query: { strings?: string[] }, ...rest: unknown[]) => {
        captured = (query.strings ?? []).join("?")
        return (runtime!.$queryRaw as (q: unknown, ...v: unknown[]) => Promise<unknown>)(
          query,
          ...rest
        )
      },
    }
    await searchKnowledge(anonymous, TOPIC_ONLY_TERM, {}, spyDb as never as MyraDb)
    expect(captured).toContain('"searchVector" @@')
    expect(captured).toContain('ts_rank("searchVector"')
    expect(captured).not.toContain("to_tsvector")
  })

  it("plans the emitted query without a Seq Scan on the seeded 1,000-row table", async () => {
    // Capture the exact statement searchKnowledge emits, then EXPLAIN it
    // verbatim — parameters rebound as $n placeholders. The audience/status
    // btree may legitimately win the plan; the point is the search predicate
    // is index-served rather than a full scan.
    let captured: { strings: string[]; values: unknown[] } | null = null
    const spyDb = {
      $queryRaw: (query: { strings: string[]; values: unknown[] }) => {
        captured = { strings: [...query.strings], values: [...query.values] }
        return runtime!.$queryRaw(query as never)
      },
    }
    await searchKnowledge(anonymous, TOPIC_ONLY_TERM, {}, spyDb as never as MyraDb)
    expect(captured).not.toBeNull()
    const { strings, values } = captured!
    const text = strings
      .map((segment, i) => segment + (i < values.length ? `$${i + 1}` : ""))
      .join("")

    const plan = await runtime!.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('enable_seqscan', 'off', true)`
      return tx.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(`EXPLAIN ${text}`, ...values)
    })
    const planText = plan.map((row) => row["QUERY PLAN"]).join("\n")
    expect(planText).not.toContain("Seq Scan")
    expect(planText).toMatch(/Index Scan|Bitmap/)
  })

  it("serves the bare searchVector predicate from myra_knowledge_entries_searchVector_idx", async () => {
    // With only the full-text predicate in play, the planner has no other
    // index to reach for — the GIN index must carry it.
    const plan = await runtime!.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('enable_seqscan', 'off', true)`
      return tx.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(
        `EXPLAIN SELECT id FROM myra_knowledge_entries
         WHERE "searchVector" @@ websearch_to_tsquery('english', '${TOPIC_ONLY_TERM}')`
      )
    })
    const planText = plan.map((row) => row["QUERY PLAN"]).join("\n")
    expect(planText).toContain("myra_knowledge_entries_searchVector_idx")
    expect(planText).not.toContain("Seq Scan")
  })
})
