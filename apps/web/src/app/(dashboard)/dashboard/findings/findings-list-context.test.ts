import { afterEach, describe, expect, it, vi } from "vitest"
import { loadFindingsListContext, saveFindingsListContext } from "./findings-list-context"
import type { FindingListItem } from "./findings-client"

const finding = (n: number): FindingListItem => ({
  id: `finding-${n}`,
  title: `Finding ${n}`,
  summary: "Summary",
  severity: "HIGH",
  status: "OPEN",
  verified: false,
  verificationStatus: "NOT_VERIFIED",
  confidence: "medium",
  firstSeenAt: "2026-09-01T00:00:00.000Z",
  lastSeenAt: "2026-09-01T00:00:00.000Z",
})

function storage() {
  const data = new Map<string, string>()
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value)
      },
    },
  })
  return data
}

afterEach(() => vi.unstubAllGlobals())

describe("findings list snapshots", () => {
  it("retains only complete pages and their own continuation cursor", () => {
    const data = storage()
    const pages = Array.from({ length: 21 }, (_, index) => ({
      items: Array.from({ length: 25 }, (_, offset) => finding(index * 25 + offset)),
      nextCursor: `cursor-${index + 1}`,
    }))
    saveFindingsListContext("key", { pages, scrollY: 500 })
    const restored = loadFindingsListContext("key")
    expect(restored?.pages).toHaveLength(20)
    expect(restored?.pages.at(-1)?.nextCursor).toBe("cursor-20")
    expect(restored?.pages.flatMap((page) => page.items)).toHaveLength(500)
    expect(JSON.parse(data.get("key")!).version).toBe(2)
  })

  it.each([
    '{"version":2,"pages":[{"items":[null],"nextCursor":null}],"scrollY":0}',
    '{"version":2,"pages":[{"items":[],"nextCursor":9}],"scrollY":0}',
    '{"version":2,"pages":[],"scrollY":-1}',
    '{"rows":[],"nextCursor":"legacy","scrollY":0}',
  ])("discards malformed or old snapshots", (raw) => {
    const data = storage()
    data.set("key", raw)
    expect(loadFindingsListContext("key")).toBeNull()
  })

  it("treats unavailable storage as a cache miss", () => {
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: () => {
          throw new Error("blocked")
        },
        setItem: () => {
          throw new Error("blocked")
        },
      },
    })
    expect(loadFindingsListContext("key")).toBeNull()
    expect(() =>
      saveFindingsListContext("key", {
        pages: [{ items: [finding(1)], nextCursor: null }],
        scrollY: 0,
      })
    ).not.toThrow()
  })
})
