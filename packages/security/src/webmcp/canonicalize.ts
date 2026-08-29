import type { WebMcpEvaluateContext, WebMcpToolSurface } from "./types"

function sortKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(sortKeys) as unknown as T
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys(value[key as keyof typeof value])
    }
    return sorted as unknown as T
  }
  return value
}

export function buildCanonicalInput(tool: WebMcpToolSurface): Record<string, unknown> {
  return sortKeys({
    kind: tool.kind,
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
    exposedTo: tool.exposedTo,
    behavior: tool.behavior,
    networkMethods: tool.networkMethods,
    returnsExternalContent: tool.returnsExternalContent,
    forwardsCancellation: tool.forwardsCancellation,
    hasRegistrationCleanup: tool.hasRegistrationCleanup,
    runtimeValidation: tool.runtimeValidation,
  })
}

export async function computeDefinitionHash(
  tool: WebMcpToolSurface,
  sha256: (input: string) => Promise<string>
): Promise<string> {
  const canonical = buildCanonicalInput(tool)
  return sha256(JSON.stringify(canonical))
}

export async function computeInventoryHash(
  definitions: WebMcpToolSurface[],
  sha256: (input: string) => Promise<string>,
  context?: WebMcpEvaluateContext,
  sources: Array<{ path: string; contentHash: string }> = []
): Promise<string> {
  const hashes = definitions.map((tool) => tool.definitionHash).sort()
  return sha256(
    JSON.stringify(
      sortKeys({
        definitions: hashes,
        headerExposure: context?.headerExposure ?? null,
        sources: [...sources].sort((a, b) => a.path.localeCompare(b.path)),
      })
    )
  )
}
