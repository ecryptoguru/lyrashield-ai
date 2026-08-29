import { describe, expect, it } from "vitest"
import { computeDefinitionHash, computeInventoryHash } from "./canonicalize"
import { sha256 } from "./hash"
import type { WebMcpToolSurface } from "./types"

describe("canonical hashes", () => {
  const baseTool: WebMcpToolSurface = {
    kind: "imperative",
    name: "sample",
    title: "Sample",
    description: "A sample tool.",
    inputSchema: { type: "object", properties: [], additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    exposedTo: null,
    behavior: "read",
    networkMethods: ["GET"],
    returnsExternalContent: false,
    forwardsCancellation: true,
    hasRegistrationCleanup: true,
    runtimeValidation: "present",
    source: { path: "src/sample.ts", startLine: 1, endLine: 5 },
    definitionHash: "",
  }

  it("produces stable definition hashes", async () => {
    const hashA = await computeDefinitionHash(baseTool, sha256)
    const hashB = await computeDefinitionHash({ ...baseTool }, sha256)
    expect(hashA).toBe(hashB)
    expect(hashA).toMatch(/^[0-9a-f]{64}$/)
  })

  it("changes the definition hash when behavior changes", async () => {
    const original = await computeDefinitionHash(baseTool, sha256)
    const modified = await computeDefinitionHash({ ...baseTool, behavior: "mutation" }, sha256)
    expect(modified).not.toBe(original)
  })

  it("excludes source path from the definition hash", async () => {
    const original = await computeDefinitionHash(baseTool, sha256)
    const moved = await computeDefinitionHash(
      { ...baseTool, source: { ...baseTool.source, path: "other.ts" } },
      sha256
    )
    expect(moved).toBe(original)
  })

  it("produces an inventory hash that is order-independent", async () => {
    const a = { ...baseTool, name: "a" } as WebMcpToolSurface
    const b = { ...baseTool, name: "b" } as WebMcpToolSurface
    a.definitionHash = await computeDefinitionHash(a, sha256)
    b.definitionHash = await computeDefinitionHash(b, sha256)

    const hash1 = await computeInventoryHash([a, b], sha256)
    const hash2 = await computeInventoryHash([b, a], sha256)
    expect(hash1).toBe(hash2)
  })

  it("binds header exposure facts into the inventory hash", async () => {
    const plain = await computeInventoryHash([], sha256)
    const exposed = await computeInventoryHash([], sha256, {
      headerExposure: { hasWildcardToolsPolicy: true },
    })

    expect(exposed).not.toBe(plain)
  })
})
