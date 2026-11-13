class OsvResponseLimitError extends Error {}

async function readBoundedResponse(
  response: Response,
  limit: number,
  signal: AbortSignal
): Promise<Response> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return response
  }
  if (!response.body) return response
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) throw new OsvResponseLimitError("OSV response size limit")
      chunks.push(chunk.value)
    }
    return new Response(Buffer.concat(chunks), {
      status: response.status,
      headers: response.headers,
    })
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** One call shares a deadline, at most two in-flight fetches and 200 detail requests. */
export function boundedOsvFetch(fetchFn: typeof fetch, signal: AbortSignal): typeof fetch {
  let active = 0
  let details = 0
  const waiting: Array<() => void> = []
  return async (url, init) => {
    if (active >= 2) await new Promise<void>((resolve) => waiting.push(resolve))
    else active++
    try {
      signal.throwIfAborted()
      if (String(url).includes("/vulns/") && ++details > 200)
        throw new Error("OSV detail request limit")
      const response = await fetchFn(url, { ...init, signal, redirect: "error" })
      const bytes = String(url).includes("/vulns/") ? 512 * 1024 : 2 * 1024 * 1024
      return await readBoundedResponse(response, bytes, signal)
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}

async function backoff(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, milliseconds)
    signal.addEventListener("abort", abort, { once: true })
  })
}

/** At most two retries, transient failures only; Retry-After cannot extend the deadline. */
export async function fetchOsvBatch(
  fetchFn: typeof fetch,
  init: RequestInit,
  signal: AbortSignal
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    let response: Response | undefined
    try {
      response = await fetchFn("https://api.osv.dev/v1/querybatch", init)
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt >= 2) return response
    } catch (error) {
      if (signal.aborted || error instanceof OsvResponseLimitError || attempt >= 2) throw error
    }
    const retryAfter = response?.headers.get("retry-after")
    const seconds = retryAfter === null || retryAfter === undefined ? NaN : Number(retryAfter)
    const delay =
      retryAfter && !Number.isFinite(seconds)
        ? Date.parse(retryAfter) - Date.now()
        : seconds * 1_000
    await response?.body?.cancel().catch(() => undefined)
    await backoff(
      Number.isFinite(delay) ? Math.min(1_000, Math.max(0, delay)) : 100 * 2 ** attempt,
      signal
    )
  }
}
