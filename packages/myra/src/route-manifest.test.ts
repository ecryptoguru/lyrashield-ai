/**
 * Unit tests for the route manifest — the allowlist `guide_workflow` and
 * starter computation use to build navigation (spec §3, §13.7). Deep links
 * must resolve here and role-gated routes must never leak to principals
 * that cannot open them.
 */
import { describe, expect, it } from "vitest"
import { ROUTE_MANIFEST, isManifestRoute, routesForPrincipal } from "./route-manifest"

const appPaths = (principal: Parameters<typeof routesForPrincipal>[0]) =>
  routesForPrincipal(principal, "app").map((r) => r.path)

const GATED_APP_ROUTES = ROUTE_MANIFEST.filter((r) => r.surface === "app" && r.minRole).map(
  (r) => r.path
)
const UNGATED_APP_ROUTES = ROUTE_MANIFEST.filter(
  (r) => r.surface === "app" && !r.minRole
).map((r) => r.path)

describe("ROUTE_MANIFEST entries", () => {
  it("every entry has the required fields", () => {
    for (const route of ROUTE_MANIFEST) {
      expect(typeof route.path).toBe("string")
      expect(route.path.startsWith("/")).toBe(true)
      expect(["marketing", "app"]).toContain(route.surface)
      expect(route.label.length).toBeGreaterThan(0)
      expect(route.description.length).toBeGreaterThan(0)
      if (route.minRole !== undefined) {
        expect(typeof route.minRole).toBe("string")
        expect(route.minRole.length).toBeGreaterThan(0)
      }
    }
  })

  it("has no duplicate path+surface pairs", () => {
    const seen = new Set<string>()
    for (const route of ROUTE_MANIFEST) {
      const key = `${route.surface}:${route.path}`
      expect(seen.has(key), key).toBe(false)
      seen.add(key)
    }
  })

  it("keeps every manifest path a valid sanitizeable relative link", () => {
    // The manifest feeds rendered links — every entry must pass the same
    // relative-path rule sanitizeLinkHref applies.
    for (const route of ROUTE_MANIFEST) {
      expect(route.path.startsWith("//")).toBe(false)
      expect(route.path.length).toBeLessThanOrEqual(300)
    }
  })
})

describe("routesForPrincipal", () => {
  it("gives anonymous principals every marketing route", () => {
    const routes = routesForPrincipal({ kind: "anonymous" }, "marketing")
    expect(routes.map((r) => r.path)).toEqual(
      ROUTE_MANIFEST.filter((r) => r.surface === "marketing").map((r) => r.path)
    )
  })

  it("hides minRole app routes from anonymous principals", () => {
    const paths = appPaths({ kind: "anonymous" })
    expect(paths.sort()).toEqual([...UNGATED_APP_ROUTES].sort())
    for (const gated of GATED_APP_ROUTES) expect(paths).not.toContain(gated)
  })

  it("hides minRole routes from users with no role", () => {
    expect(appPaths({ kind: "user", role: null })).toEqual(UNGATED_APP_ROUTES)
    expect(appPaths({ kind: "user" })).toEqual(UNGATED_APP_ROUTES)
  })

  it("hides minRole routes from unknown/under-ranked roles", () => {
    for (const role of ["SUPERUSER", "admin", "VIEWER", "AUDITOR", "EXTERNAL_PENTESTER"]) {
      const paths = appPaths({ kind: "user", role })
      for (const gated of GATED_APP_ROUTES) {
        expect(paths, `${role} must not see ${gated}`).not.toContain(gated)
      }
    }
  })

  it("admits MEMBER to member-gated routes only", () => {
    const paths = appPaths({ kind: "user", role: "MEMBER" })
    expect(paths).toContain("/dashboard/schedules")
    expect(paths).not.toContain("/dashboard/billing")
    expect(paths).not.toContain("/dashboard/admin/support")
  })

  it("admits BILLING_ADMIN to billing but not the operator inbox", () => {
    const paths = appPaths({ kind: "user", role: "BILLING_ADMIN" })
    expect(paths).toContain("/dashboard/billing")
    expect(paths).not.toContain("/dashboard/admin/support")
  })

  it("admits OWNER to every app route", () => {
    const paths = appPaths({ kind: "user", role: "OWNER" })
    expect(paths.sort()).toEqual(
      ROUTE_MANIFEST.filter((r) => r.surface === "app")
        .map((r) => r.path)
        .sort()
    )
  })

  it("admits operators to every app route (cross-workspace support console)", () => {
    const paths = appPaths({ kind: "operator" })
    expect(paths.sort()).toEqual(
      ROUTE_MANIFEST.filter((r) => r.surface === "app")
        .map((r) => r.path)
        .sort()
    )
  })
})

describe("isManifestRoute", () => {
  it("matches exact paths, optionally scoped to a surface", () => {
    expect(isManifestRoute("/pricing")).toBe(true)
    expect(isManifestRoute("/pricing", "marketing")).toBe(true)
    expect(isManifestRoute("/pricing", "app")).toBe(false)
    expect(isManifestRoute("/dashboard/billing", "app")).toBe(true)
    expect(isManifestRoute("/dashboard/billing", "marketing")).toBe(false)
  })

  it("rejects invented, partial or smuggled paths", () => {
    for (const path of [
      "/nope",
      "",
      "/pricing/",
      "/pricing?ref=myra",
      "/Pricing",
      "/dashboard/billing/edit",
      "https://lyrashieldai.com/pricing",
      "//dashboard",
      "/dashboard/../settings",
    ]) {
      expect(isManifestRoute(path), path).toBe(false)
    }
  })
})
