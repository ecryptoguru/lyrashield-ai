import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const repoRoot = process.cwd()
const allowlist = new Set([
  "packages/db/src/client.ts",
  "packages/db/src/account-deletion.ts",
])

function sourceFiles(directory: string): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test scans only repo source roots.
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : []
  })
}

describe("audit nesting regression", () => {
  it("bans tx.auditLog.create outside the allowlist (post-commit best-effort required)", () => {
    const pattern = /\btx\.auditLog\.create\b/
    const offenders = ["apps", "packages"].flatMap((root) =>
      sourceFiles(join(repoRoot, root, ""))
        .map((file) => relative(repoRoot, file))
        .filter((file) => !file.includes("/generated/"))
        .filter((file) => !allowlist.has(file))
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- file originates from sourceFiles.
        .filter((file) => pattern.test(readFileSync(join(repoRoot, file), "utf8")))
    )
    expect(
      offenders,
      "tx.auditLog.create must not be used inside a domain transaction — use post-commit prisma.auditLog.create best-effort instead. Allowlist: client.ts (extension) and account-deletion.ts (hash-chain rebuild / hard-delete + retained anonymization)."
    ).toEqual([])
  })
})
