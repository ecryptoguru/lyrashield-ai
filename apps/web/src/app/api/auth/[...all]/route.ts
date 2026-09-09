import { auth } from "@lyrashield/auth/server"
import { toNextJsHandler } from "better-auth/next-js"
import { isOAuthProtocolPath, normalizeOAuthRateLimitResponse } from "@/lib/oauth-registration"

const handlers = toNextJsHandler(auth)

export const GET = handlers.GET

export async function POST(request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname
  if (!isOAuthProtocolPath(pathname)) {
    return handlers.POST(request)
  }
  return normalizeOAuthRateLimitResponse(await handlers.POST(request))
}
