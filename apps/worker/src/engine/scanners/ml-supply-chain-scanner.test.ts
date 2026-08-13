/* eslint-disable security/detect-non-literal-fs-filename */
import { afterEach, describe, expect, it } from "vitest"
import { mkdir, rm, writeFile } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { scanMlSupplyChain } from "./ml-supply-chain-scanner"

const directories: string[] = []

async function repo(files: Record<string, string>): Promise<string> {
  const root = join(tmpdir(), `lyrashield-ml-supply-chain-${Date.now()}-${directories.length}`)
  directories.push(root)
  for (const [file, content] of Object.entries(files)) {
    const fullPath = join(root, file)
    await mkdir(fullPath.slice(0, fullPath.lastIndexOf("/")), { recursive: true })
    await writeFile(fullPath, content)
  }
  return root
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe("scanMlSupplyChain", () => {
  it("flags torch.load without weights_only=true", async () => {
    const root = await repo({ "model.py": "model = torch.load(path)" })

    const findings = await scanMlSupplyChain({ repoPath: root })

    expect(findings).toContainEqual(
      expect.objectContaining({
        control_ids: [39],
        title: expect.stringMatching(/deserialization/i),
      })
    )
  })

  it("flags mutable Hugging Face revisions without calling them poisoned", async () => {
    const root = await repo({
      "model.py": "model = snapshot_download('org/model', revision='main')",
    })

    const findings = await scanMlSupplyChain({ repoPath: root })

    expect(findings).toContainEqual(
      expect.objectContaining({ control_ids: [39], title: expect.stringMatching(/mutable/i) })
    )
    expect(findings[0]?.title).not.toMatch(/poison/i)
  })

  it("accepts an immutable revision and safetensors usage", async () => {
    const root = await repo({
      "model.py": [
        "snapshot_download('org/model', revision='0123456789abcdef0123456789abcdef01234567')",
        "from safetensors.torch import load_file",
        "weights = load_file('weights.safetensors')",
      ].join("\n"),
    })

    await expect(scanMlSupplyChain({ repoPath: root })).resolves.toEqual([])
  })
})
