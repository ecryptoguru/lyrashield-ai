import { recordScorecardEvent } from "@lyrashield/db"
import { z } from "zod"
import { apiError, apiSuccess } from "../../../../lib/api-response"

const Body = z
  .object({
    slug: z.string().regex(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{16}$/),
    eventType: z.enum(["VIEW", "SHARE"]),
    channel: z
      .enum([
        "native",
        "linkedin",
        "x",
        "bluesky",
        "whatsapp",
        "reddit",
        "email",
        "copy",
        "download",
        "embed",
      ])
      .optional(),
    variant: z.enum(["grade", "fixes"]).default("grade"),
    source: z.enum(["dashboard", "public"]).default("public"),
    visitorId: z.uuid(),
  })
  .strict()

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return apiError("INVALID_PARAM", "Invalid scorecard event", 400)
  if (parsed.data.eventType === "SHARE" && !parsed.data.channel) {
    return apiError("INVALID_PARAM", "Share channel is required", 400)
  }
  const result = await recordScorecardEvent(parsed.data.slug, parsed.data)
  if (!result) return apiError("SCORECARD_NOT_FOUND", "Scorecard not found", 404)
  return apiSuccess(result, 201)
}
