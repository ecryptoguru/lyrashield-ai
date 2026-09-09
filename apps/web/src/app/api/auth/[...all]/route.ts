import { auth } from "@lyrashield/auth/server"
import { toNextJsHandler } from "better-auth/next-js"
import {
  isOAuthProtocolPath,
  normalizeLoopbackOAuthClient,
  normalizeOAuthRateLimitResponse,
} from "@/lib/oauth-registration"

const handlers = toNextJsHandler(auth)

export const GET = handlers.GET

export async function POST(request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname
  if (!isOAuthProtocolPath(pathname)) {
    return handlers.POST(request)
  }

  let forwardedRequest = request
  try {
    if (pathname === "/api/auth/oauth2/register") {
      const body = await request.clone().json()
      const normalized = normalizeLoopbackOAuthClient(body)
      if (normalized !== body) {
        const headers = new Headers(request.headers)
        headers.delete("content-length")
        forwardedRequest = new Request(request, { body: JSON.stringify(normalized), headers })
      }
    }
  } catch {}

  return normalizeOAuthRateLimitResponse(await handlers.POST(forwardedRequest))
}
