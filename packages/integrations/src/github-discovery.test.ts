import { afterEach, expect, it, vi } from "vitest"
vi.mock("@lyrashield/config", () => ({ env: {} }))
import { getUserAdminInstallations } from "./github"
afterEach(() => vi.unstubAllGlobals())

function provider(installations: unknown[], memberships: unknown[] = [], userId = 42) {
  const fetch = vi.fn(async (url: string) => {
    const body = url.includes("/user/installations")
      ? { installations }
      : url.includes("/memberships/")
        ? memberships
        : { id: userId }
    return new Response(JSON.stringify(body), { status: 200 })
  })
  vi.stubGlobal("fetch", fetch)
  return fetch
}
it("discovers only associated personal owners and active organization admins with request-local reads", async () => {
  const fetch = provider(
    [
      { id: 1, account: { id: 42, type: "User", login: "owner" } },
      { id: 2, account: { id: 99, type: "User", login: "collaborator" } },
      { id: 3, account: { id: 100, type: "Organization", login: "admin-org" } },
      { id: 4, account: { id: 101, type: "Organization", login: "member-org" } },
      { id: 5, account: { id: 102, type: "Organization", login: "pending-org" } },
    ],
    [
      { organization: { id: 100 }, state: "active", role: "admin" },
      { organization: { id: 101 }, state: "active", role: "member" },
      { organization: { id: 102 }, state: "pending", role: "admin" },
    ]
  )
  expect(await getUserAdminInstallations("ephemeral")).toEqual({
    userId: 42,
    installations: [
      { id: 1, login: "owner" },
      { id: 3, login: "admin-org" },
    ],
  })
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("/user"))).toHaveLength(1)
  expect(fetch.mock.calls.filter(([url]) => url.includes("memberships"))).toHaveLength(1)
  await getUserAdminInstallations("different-token")
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("/user"))).toHaveLength(2)
})
it("denies selected installations absent from the fresh user's association", async () => {
  provider([{ id: 1, account: { id: 42, type: "User", login: "owner" } }])
  expect(await getUserAdminInstallations("ephemeral", 2)).toEqual({ userId: 42, installations: [] })
})
it("fails closed on a revoked token or malformed identity", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 401 }))
  )
  await expect(getUserAdminInstallations("revoked")).rejects.toThrow()
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response('{"id":"42"}'))
  )
  await expect(getUserAdminInstallations("malformed")).rejects.toThrow()
})
it("bounds candidates instead of producing an oversized chooser", async () => {
  provider(
    Array.from({ length: 21 }, (_, i) => ({
      id: i + 1,
      account: { id: 42, type: "User", login: `owner-${i}` },
    }))
  )
  await expect(getUserAdminInstallations("many")).rejects.toThrow("limit")
})

it("paginates association discovery and rechecks authority for a selected installation", async () => {
  const first = Array.from({ length: 100 }, (_, i) => ({
    id: i + 1,
    account: { id: 99, type: "User", login: "collaborator" },
  }))
  const fetch = vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.endsWith("/user")
            ? { id: 42 }
            : {
                installations: url.endsWith("page=1")
                  ? first
                  : [{ id: 777, account: { id: 42, type: "User", login: "owner" } }],
              }
        )
      )
  )
  vi.stubGlobal("fetch", fetch)
  expect(await getUserAdminInstallations("fresh", 777)).toEqual({
    userId: 42,
    installations: [{ id: 777, login: "owner" }],
  })
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "https://api.github.com/user",
    "https://api.github.com/user/installations?per_page=100&page=1",
    "https://api.github.com/user/installations?per_page=100&page=2",
  ])
})
it("fails closed when the association pager never terminates", async () => {
  const fetch = provider(
    Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      account: { id: 99, type: "User", login: "collaborator" },
    }))
  )
  await expect(getUserAdminInstallations("too-many")).rejects.toThrow("page limit")
  expect(fetch).toHaveBeenCalledTimes(21)
})
