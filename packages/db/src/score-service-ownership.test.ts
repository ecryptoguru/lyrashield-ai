import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const repoRoot = process.cwd()
const allowed = new Set(["packages/db/src/score-service.ts", "packages/db/src/account-deletion.ts"])
const models = "referralCode|referralAttribution|scorecardShare|scorecardEvent"
const access = new RegExp(`\\b(?:prisma|tx)\\.(?:${models})\\b`)

function sourceFiles(directory: string): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test scans only repo source roots.
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : []
  })
}

describe("growth-loop ownership", () => {
  it("routes manual growth-loop table access through score-service", () => {
    const offenders = ["apps", "packages"].flatMap((root) =>
      sourceFiles(join(repoRoot, root, ""))
        .filter((file) => file.includes("/src/"))
        .map((file) => relative(repoRoot, file))
        .filter((file) => !file.includes("/generated/"))
        .filter((file) => !allowed.has(file))
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- file originates from sourceFiles.
        .filter((file) => access.test(readFileSync(join(repoRoot, file), "utf8")))
    )
    expect(
      offenders,
      "growth-loop tables are isolated manually — route access through score-service.ts."
    ).toEqual([])
  })
})
