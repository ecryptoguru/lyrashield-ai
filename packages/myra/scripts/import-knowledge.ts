/** Reviewed Myra corpus import. Dry-run by default; never crawl or overwrite live entries. */
import { readFileSync } from "node:fs"
import { isTrustedSourceUrl } from "../src/sanitize"
import { z } from "zod"

const entrySchema = z.object({
  sourceId: z.string().min(1),
  topic: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  sourceUrl: z.string().url(),
  sourceRef: z.string().min(1),
  audience: z.enum(["PUBLIC", "RESTRICTED"]).default("PUBLIC"),
  allowedRoles: z.array(z.string().min(1)).default([]),
})
const corpusSchema = z.object({
  version: z.string().min(1),
  source: z.string().min(1),
  entries: z.array(entrySchema).min(1),
  questions: z.array(z.tuple([z.string(), z.string()])).min(50),
})
const corpus = corpusSchema.parse(
  JSON.parse(
    readFileSync(new URL("../../../evals/myra/knowledge-v1.json", import.meta.url), "utf8")
  )
)
if (
  new Set(corpus.entries.map((entry) => entry.sourceId)).size !== corpus.entries.length ||
  corpus.entries.some((entry) => !isTrustedSourceUrl(entry.sourceUrl)) ||
  corpus.questions.some(
    ([, sourceId]) =>
      !corpus.entries.some((entry) => entry.sourceId === sourceId && entry.audience === "PUBLIC")
  )
) {
  throw new Error("Knowledge corpus has duplicate IDs, untrusted URLs, or dangling questions")
}

const apply = process.argv.includes("--apply")
const approvedBy = process.argv.find((arg) => arg.startsWith("--approved-by="))?.slice(14)
async function main(): Promise<void> {
  if (!apply) {
    console.log(
      `${corpus.version}: ${corpus.entries.length} entries, ${corpus.questions.length} evaluation questions; dry run only`
    )
    return
  }
  if (!approvedBy) throw new Error("--apply requires --approved-by=<reviewer>")
  const { getSystemPrisma } = await import("@lyrashield/db")
  const db = getSystemPrisma()
  await db.$transaction(async (tx) => {
    const active = await tx.myraKnowledgeRelease.findFirst({ where: { status: "active" } })
    if (active)
      throw new Error(
        `Active knowledge release ${active.version} exists; review replacement explicitly`
      )
    const release = await tx.myraKnowledgeRelease.create({
      data: { version: corpus.version, approvedBy, notes: corpus.source },
    })
    await tx.myraKnowledgeEntry.createMany({
      data: corpus.entries.map((entry) => ({
        ...entry,
        releaseId: release.id,
        verifiedAt: new Date(),
      })),
    })
  })
  console.log(`${corpus.version}: imported ${corpus.entries.length} approved entries`)
}

void main()
