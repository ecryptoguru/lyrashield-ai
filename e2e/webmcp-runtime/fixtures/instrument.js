/**
 * Shared WebMCP fixture instrumentation.
 *
 * Every instrumented fixture loads this file first. It provides:
 *
 * - `window.__toolCalls` — an append-only record of every tool `execute`
 *   invocation ({name, at}). Inputs are recorded for the fixture's own
 *   assertions but the runtime checker never copies them into a receipt.
 * - `window.__webmcpFixture` — registry state: which tools were declared,
 *   whether the native `document.modelContext` API was present, and the
 *   outcome of each native `registerTool` attempt.
 * - `registerFixtureTool(tool, options)` — registers through the native API
 *   when it exists; the handler is always wrapped so effects are observable.
 * - `window.__invokeTool(name, input, {abortAfterMs})` — a test hook that
 *   calls the stored execute callback directly. The real WebMCP dispatch
 *   path is owned by the browser/agent and is not callable from page JS, so
 *   active-mode checks use this hook; the runner only calls it when the
 *   native API is present and the tool was explicitly allowlisted.
 *
 * Fixtures instrument only themselves: no network, no credentials, no real
 * payments/uploads/deletions — synthetic strings only.
 */
window.__toolCalls = []
window.__webmcpFixture = {
  tools: new Map(),
  nativeApiPresent:
    typeof document !== "undefined" &&
    typeof document.modelContext !== "undefined" &&
    document.modelContext !== null,
  registration: [],
  /** Names documented as requiring human confirmation before execution. */
  humanConfirm: [],
}

function registerFixtureTool(tool, options) {
  const wrapped = {
    ...tool,
    execute: async (input, execOptions) => {
      window.__toolCalls.push({ name: tool.name, at: new Date().toISOString(), input })
      return tool.execute(input, execOptions ?? {})
    },
  }
  window.__webmcpFixture.tools.set(tool.name, wrapped)

  if (!window.__webmcpFixture.nativeApiPresent) {
    window.__webmcpFixture.registration.push({
      name: tool.name,
      ok: false,
      error: "native-api-absent",
    })
    return Promise.resolve({ registered: false })
  }
  return Promise.resolve()
    .then(() => document.modelContext.registerTool(wrapped, options))
    .then(() => {
      window.__webmcpFixture.registration.push({ name: tool.name, ok: true })
      return { registered: true }
    })
    .catch((error) => {
      window.__webmcpFixture.registration.push({
        name: tool.name,
        ok: false,
        error: String((error && error.message) || error),
      })
      return { registered: false }
    })
}

window.__invokeTool = async function __invokeTool(name, input, opts) {
  const options = opts || {}
  const tool = window.__webmcpFixture.tools.get(name)
  if (!tool) return { called: false, error: "tool-not-registered" }
  const controller = new AbortController()
  let timer
  if (typeof options.abortAfterMs === "number") {
    timer = setTimeout(() => controller.abort(), options.abortAfterMs)
  }
  try {
    const output = await tool.execute(input === undefined ? {} : input, {
      signal: controller.signal,
    })
    return { called: true, ok: true, output }
  } catch (error) {
    return {
      called: true,
      ok: false,
      errorName: error && error.name ? error.name : "Error",
      error: String((error && error.message) || error),
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
