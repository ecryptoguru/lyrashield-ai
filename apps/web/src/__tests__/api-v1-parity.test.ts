import { describe, it, expect, vi } from "vitest"
import { posix } from "node:path"

// Export parity does not exercise auth. Avoid initializing OAuth/database resources.
vi.mock("../../../../packages/auth/src/server", () => ({
  auth: {},
  assertBrowserSession: vi.fn(),
  assertOAuthDelegatedScope: vi.fn(),
  getSession: vi.fn(),
  requirePermission: vi.fn(),
  requireWorkspaceAccess: vi.fn(),
}))

function assertAliasParity(path: string, alias: string, twin: string | undefined): string[] {
  if (!twin) throw new Error(`Missing unversioned route for ${path}`)
  const reexport = alias.trim().match(/^export \{ ([A-Z, ]+) \} from "([^"]+)";?$/)
  if (!reexport) throw new Error(`Expected direct method re-export in ${path}`)
  const expectedSource = posix
    .relative(posix.dirname(path), path.replace("/api/v1/", "/api/"))
    .replace(/\.ts$/, "")
  expect(reexport[2], `${path}: source route`).toBe(expectedSource)
  // v1 scan deletion was never exposed; changing that public contract needs separate review.
  const omitted = path === "../app/api/v1/scans/[id]/route.ts" ? ["DELETE"] : []
  const exportedMethods = [
    ...twin.matchAll(
      /\bexport (?:async )?(?:function|const) (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g
    ),
  ].map((match) => match[1]!)
  const aliasMethods = reexport[1]!.split(", ").sort()
  expect(aliasMethods, `${path}: HTTP methods`).toEqual(
    [...new Set(exportedMethods)].filter((method) => !omitted.includes(method)).sort()
  )
  return aliasMethods
}

const aliasContract: Record<string, string[]> = {
  "agent-approvals": ["GET", "POST"],
  "agent-approvals/[id]/approve": ["POST"],
  "agent-approvals/[id]/deny": ["POST"],
  "agent-operations/[id]": ["GET"],
  findings: ["GET"],
  "findings/[id]": ["GET", "PATCH"],
  "findings/[id]/fix-proposals": ["POST"],
  "findings/[id]/retests": ["POST"],
  "fix-proposals": ["GET"],
  "fix-proposals/[id]/create-pr": ["GET", "POST"],
  "gate/[targetId]": ["GET", "POST"],
  "launch-readiness": ["GET"],
  projects: ["GET", "POST"],
  reports: ["GET", "POST"],
  "reports/[id]": ["GET", "POST"],
  "reports/[id]/download": ["GET"],
  retests: ["GET"],
  scans: ["GET", "POST"],
  "scans/[id]": ["GET", "POST"],
  "scans/[id]/artifacts/sarif": ["POST"],
  "scans/[id]/quality": ["GET"],
  "scans/attachments": ["GET", "POST"],
  "scans/attachments/[id]": ["DELETE"],
  "scans/eligibility": ["GET"],
  schedules: ["GET", "POST"],
  "schedules/[id]": ["DELETE", "GET", "PATCH"],
  "target-domain-verifications": ["GET", "POST", "PUT"],
  targets: ["GET", "POST"],
  "targets/[id]": ["DELETE", "PATCH"],
  workspaces: ["GET", "POST"],
}

// Each v1 route must re-export the same HTTP method handlers as its unversioned twin.

describe("/api/v1 parity", () => {
  it("discovers every alias and matches its supported methods", () => {
    const aliases = import.meta.glob("../app/api/v1/**/route.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>
    const routes = import.meta.glob("../app/api/**/route.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>
    const discovered = Object.keys(aliases)
      .filter((path) => !path.endsWith("/v1/openapi.json/route.ts"))
      .map((path) => path.replace("../app/api/v1/", "").replace("/route.ts", ""))
    expect(discovered.sort()).toEqual(Object.keys(aliasContract).sort())

    for (const [path, alias] of Object.entries(aliases)) {
      if (path.endsWith("/v1/openapi.json/route.ts")) continue
      const route = path.replace("../app/api/v1/", "").replace("/route.ts", "")
      expect(
        assertAliasParity(path, alias, routes[path.replace("/api/v1/", "/api/")]),
        path
      ).toEqual(aliasContract[route])
    }
  })

  it("rejects an alias that points at the wrong source route", () => {
    expect(() =>
      assertAliasParity(
        "../app/api/v1/scans/route.ts",
        'export { GET, POST } from "../../targets/route"',
        "export function GET() {}\nexport const POST = handler"
      )
    ).toThrow(/source route/)
  })

  it("rejects an alias missing a supported method", () => {
    expect(() =>
      assertAliasParity(
        "../app/api/v1/scans/route.ts",
        'export { GET } from "../../scans/route"',
        "export function GET() {}\nexport const POST = handler"
      )
    ).toThrow(/HTTP methods/)
  })

  it("rejects an alias exporting the wrong method", () => {
    expect(() =>
      assertAliasParity(
        "../app/api/v1/scans/route.ts",
        'export { GET, PUT } from "../../scans/route"',
        "export function GET() {}\nexport const POST = handler"
      )
    ).toThrow(/HTTP methods/)
  })

  it("rejects exposing scan deletion through v1", () => {
    expect(() =>
      assertAliasParity(
        "../app/api/v1/scans/[id]/route.ts",
        'export { GET, POST, DELETE } from "../../../scans/[id]/route"',
        "export function GET() {}\nexport const POST = handler\nexport async function DELETE() {}"
      )
    ).toThrow(/HTTP methods/)
  })

  it("rejects an alias whose unversioned twin is missing", () => {
    expect(() =>
      assertAliasParity(
        "../app/api/v1/scans/route.ts",
        'export { GET } from "../../scans/route"',
        undefined
      )
    ).toThrow(/Missing unversioned route/)
  })

  it("re-exports the scan handlers at runtime while omitting DELETE", async () => {
    const v1 = await import("../app/api/v1/scans/[id]/route")
    const twin = await import("../app/api/scans/[id]/route")
    expect(v1.GET).toBe(twin.GET)
    expect(v1.POST).toBe(twin.POST)
    expect(twin.DELETE).toBeTypeOf("function")
    expect(v1).not.toHaveProperty("DELETE")
  })
})
