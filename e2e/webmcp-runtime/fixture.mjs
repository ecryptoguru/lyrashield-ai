import { createServer } from "node:http"

const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>WebMCP runtime fixture</title>
<body><h1>WebMCP runtime fixture</h1><button id="next">Leave fixture</button>
<iframe src="CROSS_ORIGIN" allow="tools" title="Synthetic cross-origin fixture"></iframe>
<script>
  window.fixtureState = { calls: 0, slowStarted: false, signalProvided: false, aborted: false, confirmed: false }
  const lifetime = new AbortController()
  const schema = { type: "object", additionalProperties: false,
    properties: { value: { type: "string", maxLength: 20 } }, required: ["value"] }
  document.modelContext?.registerTool({
    name: "fixture_echo", title: "Echo synthetic value", description: "Returns a synthetic value.",
    inputSchema: schema, annotations: { readOnlyHint: true },
    execute: ({ value }) => {
      if (typeof value !== "string" || value.length > 20) throw new TypeError("Invalid synthetic value")
      window.fixtureState.calls++
      return { value }
    },
  }, { signal: lifetime.signal })
  document.modelContext?.registerTool({
    name: "fixture_slow", title: "Slow synthetic read", description: "Waits until aborted.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true },
    execute: (_, options) => new Promise((resolve, reject) => {
      window.fixtureState.slowStarted = true
      const signal = options?.signal
      window.fixtureState.signalProvided = Boolean(signal)
      signal?.addEventListener("abort", () => {
        window.fixtureState.aborted = true
        reject(new DOMException("Aborted", "AbortError"))
      }, { once: true })
      setTimeout(() => resolve({ done: true }), 2000)
    }),
  }, { signal: lifetime.signal })
  document.modelContext?.registerTool({
    name: "fixture_confirm", title: "Synthetic confirmation", description: "Requires visible confirmation.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { consequentialHint: true },
    execute: async () => {
      if (!confirm("Confirm synthetic fixture action?")) return { confirmed: false }
      window.fixtureState.confirmed = true
      return { confirmed: true }
    },
  }, { signal: lifetime.signal })
  document.querySelector("#next").addEventListener("click", () => { lifetime.abort(); location.href = "/next" })
</script></body></html>`

export async function startFixture() {
  const crossServer = createServer((_request, response) => {
    response.setHeader("Origin-Agent-Cluster", "?1")
    response.setHeader("Permissions-Policy", "tools=(self)")
    response.setHeader("Content-Type", "text/html; charset=utf-8")
    response.end(`<!doctype html><title>Cross-origin fixture</title><script>
      document.modelContext?.registerTool({ name: "fixture_private_cross", description: "Private synthetic tool.",
        inputSchema: { type: "object", properties: {} }, execute: () => "private" })
    </script>`)
  })
  await new Promise((resolve) => crossServer.listen(0, "127.0.0.1", resolve))
  const crossOrigin = `http://127.0.0.1:${crossServer.address().port}`
  const server = createServer((request, response) => {
    response.setHeader("Origin-Agent-Cluster", "?1")
    response.setHeader("Permissions-Policy", `tools=(self "${crossOrigin}")`)
    response.setHeader("Content-Type", "text/html; charset=utf-8")
    response.setHeader("Cache-Control", "no-store")
    response.end(
      request.url === "/"
        ? html.replace("CROSS_ORIGIN", crossOrigin)
        : "<!doctype html><title>Next</title><p>Fixture ended.</p>"
    )
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    crossOrigin,
    close: async () => {
      await Promise.all([
        new Promise((resolve) => server.close(resolve)),
        new Promise((resolve) => crossServer.close(resolve)),
      ])
    },
  }
}
