import { z } from "zod"

export const OSV_CACHE_SCHEMA_VERSION = "osv-querybatch/2"

export const OsvVulnerabilitySchema = z.object({
  id: z.string().min(1).max(200),
  summary: z.string().optional(),
  details: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  severity: z.array(z.object({ type: z.string(), score: z.string() })).optional(),
  references: z.array(z.object({ url: z.string() })).optional(),
  affected: z
    .array(
      z.object({
        package: z.object({ name: z.string().min(1), ecosystem: z.string().min(1) }).optional(),
        ranges: z
          .array(
            z.object({
              type: z.string().optional(),
              events: z.array(
                z.object({
                  introduced: z.string().optional(),
                  fixed: z.string().optional(),
                  last_affected: z.string().optional(),
                })
              ),
            })
          )
          .optional(),
      })
    )
    .optional(),
  database_specific: z
    .object({
      severity: z.string().optional(),
      cvss: z.object({ vectorString: z.string() }).optional(),
    })
    .optional(),
})
export type OsvVulnerability = z.infer<typeof OsvVulnerabilitySchema>

export function hasOsvDetails(vulnerability: OsvVulnerability): boolean {
  return Array.isArray(vulnerability.affected)
}

async function readDetail(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error("OSV details unavailable")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 512 * 1024) throw new Error("OSV detail size limit")
      chunks.push(chunk.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** Batch responses contain IDs only. Retain those detections if bounded detail retrieval fails. */
export async function hydrateOsvDetails(
  candidates: OsvVulnerability[],
  fetchFn: typeof fetch,
  signal?: AbortSignal
): Promise<{ vulns: OsvVulnerability[]; incomplete: boolean }> {
  const parsed = candidates.map((candidate) => OsvVulnerabilitySchema.safeParse(candidate))
  const valid = parsed.flatMap((result) => (result.success ? [result.data] : []))
  const details = new Map(
    valid.filter(hasOsvDetails).map((vulnerability) => [vulnerability.id, vulnerability])
  )
  const missing = [
    ...new Set(
      valid
        .filter((vulnerability) => !hasOsvDetails(vulnerability))
        .map((vulnerability) => vulnerability.id)
    ),
  ]
  let incomplete = valid.length !== candidates.length || missing.length > 200
  for (let start = 0; start < Math.min(missing.length, 200); start += 8) {
    await Promise.all(
      missing.slice(start, Math.min(start + 8, 200)).map(async (id) => {
        try {
          if (signal?.aborted || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id))
            throw new Error("Invalid OSV detail request")
          const response = await fetchFn(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, {
            signal,
            redirect: "error",
          })
          const detail = OsvVulnerabilitySchema.parse(await readDetail(response))
          if (detail.id !== id || !hasOsvDetails(detail))
            throw new Error("OSV detail identity mismatch")
          details.set(id, detail)
        } catch {
          incomplete = true
        }
      })
    )
  }
  return {
    vulns: valid.map((vulnerability) => details.get(vulnerability.id) ?? vulnerability),
    incomplete,
  }
}
