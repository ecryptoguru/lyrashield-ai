/* eslint-disable security/detect-non-literal-fs-filename */
import { afterEach, describe, expect, it } from "vitest"
import { mkdir, rm, writeFile } from "fs/promises"
import { join } from "path"
import { resolveExactDependencies } from "./resolved-dependencies"

const tempDirectories: string[] = []

async function repo(files: Record<string, string>): Promise<string> {
  const root = join(
    process.cwd(),
    "tmp-resolved-dependencies-test",
    `${Date.now()}-${tempDirectories.length}`
  )
  tempDirectories.push(root)
  await mkdir(root, { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    const destination = join(root, path)
    await mkdir(join(destination, ".."), { recursive: true })
    await writeFile(destination, content)
  }
  return root
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe("resolveExactDependencies", () => {
  it("uses an exact package-lock release and deduplicates packages", async () => {
    const root = await repo({
      "package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "node_modules/lodash": { version: "4.17.20" },
          "node_modules/lodash/node_modules/lodash": { version: "4.17.20" },
        },
      }),
    })

    const inventory = await resolveExactDependencies({ repoPath: root })

    expect(inventory).toMatchObject({ status: "COMPLETE", truncated: false })
    expect(inventory.packages).toEqual([
      expect.objectContaining({ ecosystem: "npm", name: "lodash", version: "4.17.20" }),
    ])
  })

  it("never treats a manifest range or a missing lock resolution as an installed release", async () => {
    const root = await repo({
      "package.json": JSON.stringify({ dependencies: { lodash: "^4.17.0" } }),
      "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: {} }),
    })

    const inventory = await resolveExactDependencies({ repoPath: root })

    expect(inventory.status).toBe("UNSUPPORTED")
    expect(inventory.packages).toEqual([])
    expect(inventory.unresolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "lodash",
          reason: expect.stringContaining("not resolved"),
        }),
      ])
    )
  })

  it("marks non-pinned Python requirements partial instead of querying a guessed version", async () => {
    const root = await repo({ "requirements.txt": "requests>=2.0\nflask==3.0.0\n" })

    const inventory = await resolveExactDependencies({ repoPath: root })

    expect(inventory.status).toBe("PARTIAL")
    expect(inventory.packages).toEqual([
      expect.objectContaining({ ecosystem: "PyPI", name: "flask", version: "3.0.0" }),
    ])
    expect(inventory.unresolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "dependency is not pinned to an exact version" }),
      ])
    )
  })
})
