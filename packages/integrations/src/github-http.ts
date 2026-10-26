export const GITHUB_API_BASE = "https://api.github.com"

export const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
} as const

/**
 * fetch() wrapper that retries transient GitHub failures: 5xx, 429, and 403s
 * that carry a Retry-After (secondary rate limit). A 403 WITHOUT Retry-After is
 * an auth/permission error and is NOT retried. Honors Retry-After, else backs
 * off exponentially (capped).
 *
 * Exported for the read-only outbound connector tools (connectors/github.ts);
 * callers must keep it on GET/HEAD paths — the retry policy assumes idempotent
 * requests.
 */
export async function githubFetch(
  url: string,
  init: RequestInit,
  retries = 3,
  fetchFn: typeof fetch = fetch
): Promise<Response> {
  let attempt = 0
  while (true) {
    const res = await fetchFn(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(30_000),
    })
    if (res.ok || attempt >= retries) return res

    const retryAfter = res.headers.get("retry-after")
    const isSecondaryRateLimit = res.status === 403 && retryAfter !== null
    const retryable = res.status >= 500 || res.status === 429 || isSecondaryRateLimit
    if (!retryable) return res

    const delayMs = retryAfter ? Number(retryAfter) * 1000 : Math.min(1000 * 2 ** attempt, 8000)
    await new Promise((r) => setTimeout(r, delayMs))
    attempt++
  }
}
