import { cookies } from "next/headers"
import type { NextRequest } from "next/server"
import { createHmac } from "node:crypto"
import { attributeReferral } from "@lyrashield/db"
import { getSession } from "@lyrashield/auth/server"
import { env } from "@lyrashield/config"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { getClientIP } from "@/proxy"

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return apiError("UNAUTHORIZED", "Authentication required", 401)
  const cookieStore = await cookies()
  const code = cookieStore.get("ls_ref")?.value
  if (!code) return apiSuccess({ attributed: false })
  const source = cookieStore.get("ls_ref_source")?.value ?? "scorecard"
  const ip = getClientIP(request)
  const attribution = await attributeReferral(
    code,
    session.userId,
    createHmac("sha256", env.BETTER_AUTH_SECRET).update(ip).digest("hex"),
    source
  )
  cookieStore.delete("ls_ref")
  cookieStore.delete("ls_ref_source")
  return apiSuccess({ attributed: Boolean(attribution) })
}
