import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

it("guards every route mutation that resolves a browser session", () => {
  const app = fileURLToPath(new URL("../app/", import.meta.url))
  const unguarded: string[] = []
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repository test directory, no request input
  for (const name of readdirSync(app, { recursive: true })) {
    if (typeof name !== "string" || !name.endsWith("/route.ts")) continue
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- name comes from the fixed repository directory above
    const source = readFileSync(resolve(app, name), "utf8")
    if (
      !/\b(?:getSession|getCachedSession|requireAuth|requirePermission|requireWorkspaceAccess)\(/.test(
        source
      )
    )
      continue
    if (/export async function (?:POST|PUT|PATCH|DELETE)\(/.test(source)) unguarded.push(name)
    for (const match of source.matchAll(/export const (POST|PUT|PATCH|DELETE)\s*=\s*(\w+)/g)) {
      if (match[2] !== "withCookieMutation") unguarded.push(`${name}:${match[1]}`)
    }
  }
  expect(unguarded).toEqual([])
})
