import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { AgentEntry } from "@lyrashield/agent-registry"
import { findDetectedLocations } from "../../installers/detect.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("agent plugin detection", () => {
  it("reports an installed plugin directory as configured", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lyrashield-plugin-detect-"))
    tempDirs.push(root)
    const pluginPath = path.join(root, "lyrashield")
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- isolated test path
    await mkdir(pluginPath)
    const agent: AgentEntry = {
      id: "test-agent-plugin",
      displayName: "Test Agent Plugin",
      docsSlug: "test-agent",
      installStrategy: "agent-plugin",
      format: null,
      rootKey: null,
      locations: [],
      pluginLocations: [{ scope: "global", path: pluginPath, sharedByConvention: false }],
      transports: ["remote-http"],
      credential: { kind: "ui-fields" },
      rulesFiles: [],
      source: { checkedOn: "2026-09-10", url: "https://example.com" },
      gotchas: [],
    }

    const [location] = await findDetectedLocations(agent)

    expect(location).toMatchObject({ resolvedPath: pluginPath, exists: true, hasEntry: true })
  })
})
