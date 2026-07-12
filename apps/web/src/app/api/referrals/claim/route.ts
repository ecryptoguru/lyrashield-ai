import { cookies, headers } from "next/headers"
import { createHash } from "node:crypto"
import { attributeReferral } from "@lyrashield/db"
import { getSession } from "@lyrashield/auth/server"
import { apiError, apiSuccess } from "../../../../lib/api-response"

export async function POST() {
  const session = await getSession()
  if (!session) return apiError("UNAUTHORIZED", "Authentication required", 401)
  const code = (await cookies()).get("ls_ref")?.value
  if (!code) return apiSuccess({ attributed: false })
  const ip =
    (await headers()).get(process.env.TRUSTED_PROXY_IP_HEADER?.toLowerCase() ?? "") ?? "unknown"
  const attribution = await attributeReferral(
    code,
    session.userId,
    createHash("sha256").update(ip).digest("hex")
  )
  return apiSuccess({ attributed: Boolean(attribution) })
}
