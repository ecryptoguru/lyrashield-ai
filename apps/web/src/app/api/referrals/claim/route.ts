import { cookies, headers } from "next/headers"
import { createHmac } from "node:crypto"
import { attributeReferral } from "@lyrashield/db"
import { getSession } from "@lyrashield/auth/server"
import { env } from "@lyrashield/config"
import { apiError, apiSuccess } from "../../../../lib/api-response"

export async function POST() {
  const session = await getSession()
  if (!session) return apiError("UNAUTHORIZED", "Authentication required", 401)
  const cookieStore = await cookies()
  const code = cookieStore.get("ls_ref")?.value
  if (!code) return apiSuccess({ attributed: false })
  const source = cookieStore.get("ls_ref_source")?.value ?? "scorecard"
  const ip =
    (await headers()).get(process.env.TRUSTED_PROXY_IP_HEADER?.toLowerCase() ?? "") ?? "unknown"
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
