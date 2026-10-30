import { afterEach, describe, expect, it } from "vitest"
import { mkdir, rm, writeFile } from "fs/promises"
import { join } from "path"
import { resolveExactDependencies } from "./resolved-dependencies"
import { composerContentHash } from "./composer-dependencies"

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

// These exercise on-disk repositories: a missing Composer resolver or an unsafe
// version fallback must change the inventory, not merely a parser mock.
describe("Composer inventory", () => {
  it("marks preserved Composer locations beyond the inventory cap incomplete", async () => {
    const manifest = { require: { "vendor/pkg0": "^1" } }
    const lock = JSON.stringify({
      "content-hash": composerContentHash(manifest),
      packages: Array.from({ length: 251 }, (_, index) => ({
        name: `vendor/pkg${index}`,
        version: "1.0.0",
      })),
    })
    const root = await repo({
      "one/composer.json": JSON.stringify(manifest),
      "one/composer.lock": lock,
      "two/composer.json": JSON.stringify(manifest),
      "two/composer.lock": lock,
    })
    const inventory = await resolveExactDependencies({ repoPath: root })
    expect(inventory).toMatchObject({ status: "PARTIAL", truncated: true })
    expect(inventory.packages).toHaveLength(500)
    expect(inventory.unresolved).toContainEqual(
      expect.objectContaining({ reason: "dependency limit reached (500)" })
    )
  })

  it("resolves runtime, transitive and development releases without platform constraints", async () => {
    const root = await repo({
      "composer.json": JSON.stringify({
        require: { php: "^8.3", "ext-json": "*", "lib-curl": "*", "vendor/pkg": "^1.0" },
        "require-dev": { "vendor/test": "^3" },
      }),
      "composer.lock": JSON.stringify({
        "content-hash": "13697fcd4f04323a28c04b9681c8758e",
        packages: [
          { name: "vendor/pkg", version: "v1.2.3" },
          { name: "vendor/transitive", version: "2.4.0" },
        ],
        "packages-dev": [{ name: "vendor/test", version: "3.1.0-RC1" }],
      }),
    })
    const inventory = await resolveExactDependencies({ repoPath: root })
    expect(inventory.status).toBe("COMPLETE")
    expect(inventory.packages).toEqual([
      { name: "vendor/pkg", version: "1.2.3", ecosystem: "Packagist", filePath: "composer.lock" },
      {
        name: "vendor/transitive",
        version: "2.4.0",
        ecosystem: "Packagist",
        filePath: "composer.lock",
      },
      {
        name: "vendor/test",
        version: "3.1.0-RC1",
        ecosystem: "Packagist",
        filePath: "composer.lock",
      },
    ])
  })

  it.each([false, true])(
    "requires both ecosystems to resolve in a mixed repository (lock=%s)",
    async (locked) => {
      const root = await repo({
        "package-lock.json": JSON.stringify({
          packages: { "node_modules/lodash": { version: "4.17.21" } },
        }),
        "composer.json": JSON.stringify({ require: { "vendor/pkg": "^1.0" } }),
        ...(locked
          ? {
              "composer.lock": JSON.stringify({
                "content-hash": "744566ed8d27e73853a77d1b6ae30afc",
                packages: [{ name: "vendor/pkg", version: "1.2.3" }],
              }),
            }
          : {}),
      })
      const coverageIssues: import("../scanner-coverage").ScannerCoverageIssue[] = []
      const inventory = await resolveExactDependencies({ repoPath: root, coverageIssues })
      expect(inventory.status).toBe(locked ? "COMPLETE" : "PARTIAL")
      if (!locked) {
        expect(inventory.unresolved).toContainEqual(
          expect.objectContaining({ ecosystem: "Packagist", name: "vendor/pkg" })
        )
        expect(coverageIssues).toContainEqual(
          expect.objectContaining({ scanner: "sca", status: "partial" })
        )
      }
    }
  )

  it("marks a resolved Composer tree partial when an npm root has no lock", async () => {
    const root = await repo({
      "package.json": JSON.stringify({ dependencies: { lodash: "^4" } }),
      "composer.lock": JSON.stringify({ packages: [{ name: "vendor/pkg", version: "1.2.3" }] }),
    })
    expect((await resolveExactDependencies({ repoPath: root })).status).toBe("PARTIAL")
  })

  it("retains safe packages while rejecting dynamic releases and malformed package records", async () => {
    const root = await repo({
      "composer.lock": JSON.stringify({
        packages: [
          { name: "vendor/good", version: "1.2.3" },
          ...[
            "dev-main",
            "1.x-dev",
            "^1.2",
            "1.2.3 as 2.0.0",
            "1.2.3\n",
            "https://host/version",
          ].map((version) => ({ name: "vendor/unsafe", version })),
          null,
          { name: "../bad", version: "1.0.0" },
          { name: "vendor/no-version" },
          { name: "ext-json", version: "1.0.0" },
        ],
      }),
    })
    const inventory = await resolveExactDependencies({ repoPath: root })
    expect(inventory.status).toBe("PARTIAL")
    expect(inventory.packages).toEqual([
      { name: "vendor/good", version: "1.2.3", ecosystem: "Packagist", filePath: "composer.lock" },
    ])
    expect(inventory.unresolved.length).toBeGreaterThan(0)
  })

  it("records stale root requirements without guessing their versions", async () => {
    const root = await repo({
      "composer.json": JSON.stringify({ require: { "vendor/missing": "^2.0" } }),
      "composer.lock": JSON.stringify({ packages: [{ name: "vendor/other", version: "1.2.3" }] }),
    })
    const inventory = await resolveExactDependencies({ repoPath: root })
    expect(inventory.status).toBe("PARTIAL")
    expect(inventory.unresolved).toContainEqual(
      expect.objectContaining({
        name: "vendor/missing",
        reason: expect.stringContaining("not resolved"),
      })
    )
    expect(inventory.packages.some((pkg) => pkg.name === "vendor/missing")).toBe(false)
  })

  it.each(["{", "[]", JSON.stringify({ packages: {} }), " ".repeat(512 * 1024 + 1)])(
    "marks malformed or oversized Composer input unsupported",
    async (content) => {
      const root = await repo({ "composer.lock": content })
      const coverageIssues: import("../scanner-coverage").ScannerCoverageIssue[] = []
      const inventory = await resolveExactDependencies({ repoPath: root, coverageIssues })
      expect(inventory.status).toBe("UNSUPPORTED")
      expect(inventory.packages).toEqual([])
      expect(coverageIssues).toContainEqual(expect.objectContaining({ scanner: "sca" }))
    }
  )

  it("records unreadable repository paths instead of a clean empty inventory", async () => {
    const root = await repo({})
    const coverageIssues: import("../scanner-coverage").ScannerCoverageIssue[] = []
    const inventory = await resolveExactDependencies({
      repoPath: join(root, "missing"),
      coverageIssues,
    })
    expect(inventory.status).toBe("UNSUPPORTED")
    expect(coverageIssues).toContainEqual(
      expect.objectContaining({ scanner: "sca", reason: expect.stringContaining("read") })
    )
  })
})

describe("Composer freshness", () => {
  it.each([undefined, "invalid", "00000000000000000000000000000000"])(
    "retains lock releases but marks missing or stale content hashes partial (%s)",
    async (hash) => {
      const root = await repo({
        "composer.json": JSON.stringify({ require: { "vendor/pkg": "^1.0" } }),
        "composer.lock": JSON.stringify({
          "content-hash": hash,
          packages: [{ name: "vendor/pkg", version: "1.2.3" }],
        }),
      })
      const issues: import("../scanner-coverage").ScannerCoverageIssue[] = []
      const inventory = await resolveExactDependencies({ repoPath: root, coverageIssues: issues })
      expect(inventory.status).toBe("PARTIAL")
      expect(inventory.packages).toContainEqual({
        name: "vendor/pkg",
        version: "1.2.3",
        ecosystem: "Packagist",
        filePath: "composer.lock",
      })
      expect(issues).toContainEqual(expect.objectContaining({ scanner: "sca", status: "partial" }))
    }
  )

  it("retains lock-only packages with an explicit missing-manifest coverage issue", async () => {
    const root = await repo({
      "composer.lock": JSON.stringify({ packages: [{ name: "vendor/pkg", version: "1.2.3" }] }),
    })
    const issues: import("../scanner-coverage").ScannerCoverageIssue[] = []
    expect(
      (await resolveExactDependencies({ repoPath: root, coverageIssues: issues })).status
    ).toBe("PARTIAL")
    expect(issues).toContainEqual(
      expect.objectContaining({ scanner: "sca", reason: expect.stringContaining("manifest") })
    )
  })
})

describe("Composer inventory boundaries", () => {
  it("preserves root npm lock resolution for workspace manifests in mixed repositories", async () => {
    const root = await repo({
      "package-lock.json": JSON.stringify({
        packages: { "node_modules/lodash": { version: "4.17.21" } },
      }),
      "apps/web/package.json": JSON.stringify({ dependencies: { lodash: "^4" } }),
      "composer.json": JSON.stringify({ require: { "vendor/pkg": "^1.0" } }),
      "composer.lock": JSON.stringify({
        "content-hash": "744566ed8d27e73853a77d1b6ae30afc",
        packages: [{ name: "vendor/pkg", version: "1.2.3" }],
      }),
    })
    expect((await resolveExactDependencies({ repoPath: root })).status).toBe("COMPLETE")
  })

  it("rejects package names with trailing control characters", async () => {
    const root = await repo({
      "composer.lock": JSON.stringify({ packages: [{ name: "vendor/pkg\n", version: "1.2.3" }] }),
    })
    expect((await resolveExactDependencies({ repoPath: root })).packages).toEqual([])
  })

  it("retains exact releases with partial coverage when a deeply nested manifest cannot be hashed", async () => {
    const root = await repo({
      "composer.json":
        '{"require":{"vendor/pkg":"^1.0"},"extra":' +
        "[".repeat(6000) +
        "0" +
        "]".repeat(6000) +
        "}",
      "composer.lock": JSON.stringify({
        "content-hash": "744566ed8d27e73853a77d1b6ae30afc",
        packages: [{ name: "vendor/pkg", version: "1.2.3" }],
      }),
    })
    const inventory = await resolveExactDependencies({ repoPath: root })
    expect(inventory.status).toBe("PARTIAL")
    expect(inventory.packages).toHaveLength(1)
  })
})

describe("Mixed manifest failures", () => {
  it.each(["{", "[]", '{"dependencies":[]}'])(
    "keeps malformed npm manifests incomplete alongside resolved Composer packages (%s)",
    async (manifest) => {
      const root = await repo({
        "package.json": manifest,
        "composer.json": JSON.stringify({ require: { "vendor/pkg": "^1.0" } }),
        "composer.lock": JSON.stringify({
          "content-hash": "744566ed8d27e73853a77d1b6ae30afc",
          packages: [{ name: "vendor/pkg", version: "1.2.3" }],
        }),
      })
      expect((await resolveExactDependencies({ repoPath: root })).status).toBe("PARTIAL")
    }
  )
})

it("ignores Composer documentation and fixture files while retaining JavaScript dependency resolution", async () => {
  const root = await repo({
    "package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: { "node_modules/lodash": { version: "4.17.20" } },
    }),
    "docs/composer.json": "malformed example",
    "fixtures/composer.lock": JSON.stringify({
      packages: [{ name: "vendor/example", version: "1.2.3" }],
    }),
  })
  const inventory = await resolveExactDependencies({ repoPath: root })
  expect(inventory.status).toBe("COMPLETE")
  expect(inventory.packages).toEqual([
    expect.objectContaining({ ecosystem: "npm", name: "lodash" }),
  ])
  expect(inventory.unresolved).toEqual([])
})

it.each([
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "Gemfile",
  "Gemfile.lock",
  "pom.xml",
  "build.gradle",
  "packages.lock.json",
  "pyproject.toml",
  "poetry.lock",
])("keeps mixed-repository coverage incomplete for unsupported %s", async (manifest) => {
  const root = await repo({
    "requirements.txt": "flask==3.0.0\n",
    [`other/${manifest}`]: "unsupported",
  })
  const inventory = await resolveExactDependencies({ repoPath: root })
  expect(inventory.status).toBe("PARTIAL")
  expect(inventory.packages).toHaveLength(1)
  expect(inventory.unresolved).toContainEqual(
    expect.objectContaining({
      name: `other/${manifest}`,
      reason: expect.stringMatching(/unsupported/i),
    })
  )
})
