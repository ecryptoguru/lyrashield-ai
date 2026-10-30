/** Read one bounded film completely before giving it to the native decoder. */
export async function bufferMotion(
  url: string,
  signal: AbortSignal,
  maxBytes: number,
  progress: (percent: number) => void
): Promise<Blob> {
  let response: Response
  try {
    response = await fetch(url, { signal })
  } catch (error) {
    signal.throwIfAborted()
    if (!(error instanceof TypeError)) throw error
    // A previously cached non-CORS response can poison a later fetch of the
    // same immutable film. Refresh once; keep CORS and all byte/deadline limits.
    response = await fetch(url, { signal, cache: "reload" })
  }
  if (!response.ok || !response.body) throw new Error("Motion download unavailable")
  const total = Number(response.headers.get("content-length"))
  const reader = response.body.getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  try {
    if (total > maxBytes) throw new Error("Motion exceeds its byte budget")
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw new Error("Motion exceeds its byte budget")
      chunks.push(value)
      if (total > 0) progress(Math.min(99, Math.floor((size / total) * 100)))
    }
    if (!size || (total > 0 && size !== total)) throw new Error("Incomplete motion download")
    signal.throwIfAborted()
    return new Blob(chunks, { type: "video/mp4" })
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
}
