/**
 * Streams a bounded response body instead of buffering the whole payload
 * before enforcing the cap. The reader is cancelled as soon as the cap is
 * exceeded so an oversized upstream stream cannot exhaust memory.
 */
export async function readBoundedResponseText(
  response: Pick<Response, "body">,
  maxBytes: number,
  label: string
): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`${label} response is oversized`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total
  ).toString("utf8")
}
