import "./test-env"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { createBoundedPgAdapter } from "@lyrashield/db"
import { PrismaClient } from "@lyrashield/db/src/generated/prisma"
import type { MyraPrincipal } from "../contracts"
import { searchKnowledge } from "./kb"

const corpus = JSON.parse(
  // The path is a fixed, repository-owned test fixture resolved from this module.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  readFileSync(new URL("../../../../evals/myra/knowledge-v1.json", import.meta.url), "utf8")
) as {
  version: string
  entries: Array<{
    sourceId: string
    topic: string
    title: string
    content: string
    sourceUrl: string
    sourceRef: string
  }>
  questions: Array<[string, string]>
}
const runtimeUrl = process.env.RLS_RUNTIME_DATABASE_URL
const runtime = runtimeUrl
  ? new PrismaClient({ adapter: createBoundedPgAdapter(runtimeUrl) })
  : null
const suffix = randomUUID().replace(/-/g, "")
const releaseId = `myra-corpus-eval-${suffix}`
const entryId = (sourceId: string) => `myra-corpus-${sourceId}-${suffix}`
const anonymous: MyraPrincipal = { kind: "anonymous", publicSessionId: `corpus-${suffix}` }

describe.skipIf(!runtime)("reviewed Myra corpus on PostgreSQL full-text search", () => {
  beforeAll(async () => {
    await runtime!.myraKnowledgeRelease.create({
      data: { id: releaseId, version: `${corpus.version}-eval-${suffix}` },
    })
    await runtime!.myraKnowledgeEntry.createMany({
      data: [
        ...corpus.entries.map((entry) => ({
          ...entry,
          id: entryId(entry.sourceId),
          releaseId,
          allowedRoles: [],
          audience: "PUBLIC" as const,
        })),
        {
          id: entryId("restricted-decoy"),
          releaseId,
          sourceId: "restricted-decoy",
          topic: "internal-only-quartz-needle",
          title: "Restricted operator instruction",
          content: "internal-only-quartz-needle must never reach public retrieval",
          allowedRoles: ["OWNER"],
          audience: "RESTRICTED" as const,
        },
      ],
    })
  })

  afterAll(async () => {
    if (!runtime) return
    await runtime.myraKnowledgeRelease.deleteMany({ where: { id: releaseId } })
    await runtime.$disconnect()
  })

  it("retrieves the expected public source in the top five for at least 90% of 60 questions", async () => {
    expect(corpus.questions.length).toBeGreaterThanOrEqual(50)
    let hits = 0
    for (const [query, expected] of corpus.questions) {
      const results = await searchKnowledge(anonymous, query, { limit: 5 }, runtime!)
      if (results.some((result) => result.entryId === entryId(expected))) hits++
    }
    expect(hits / corpus.questions.length).toBeGreaterThanOrEqual(0.9)
  })

  it("never returns restricted content to an anonymous visitor", async () => {
    const results = await searchKnowledge(
      anonymous,
      "internal-only-quartz-needle",
      { limit: 5 },
      runtime!
    )
    expect(results.every((result) => result.entryId !== entryId("restricted-decoy"))).toBe(true)
  })
})
