import { auth } from "@lyrashield/auth/server"
import { toNextJsHandler } from "better-auth/next-js"
import { normalizeLoopbackOAuthClient } from "@/lib/oauth-registration"

const handlers = toNextJsHandler(auth)

export const GET = handlers.GET

export async function POST(request: Request): Promise<Response> {
  if (new URL(request.url).pathname !== "/api/auth/oauth2/register") {
    return handlers.POST(request)
  }

  try {
    const body = await request.clone().json()
    const normalized = normalizeLoopbackOAuthClient(body)
    if (normalized === body) return handlers.POST(request)

    const headers = new Headers(request.headers)
    headers.delete("content-length")
    return handlers.POST(new Request(request, { body: JSON.stringify(normalized), headers }))
  } catch {
    return handlers.POST(request)
  }
}
