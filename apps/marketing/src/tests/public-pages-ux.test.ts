import { describe, expect, it, vi } from "vitest"
import { reviewSecretFiles } from "../lib/local-secret-files"
import { formatBlogDate } from "../lib/blog-date"
import { primaryBlogTopic } from "../lib/blog-topics"

const file = (name: string, text = "ordinary text", overrides = {}) => ({
  name,
  size: text.length,
  type: "text/plain",
  text: vi.fn(async () => text),
  ...overrides,
})

describe("bounded local secret file review", () => {
  it("rejects an oversized selection before reading any file", async () => {
    const files = Array.from({ length: 21 }, (_, i) => file(`fixture-${i}.txt`))
    const result = await reviewSecretFiles(files)
    expect(result.join(" ")).toContain("21 files selected; 0 scanned")
    files.forEach((entry) => expect(entry.text).not.toHaveBeenCalled())
  })
  it("reports exact coverage for oversized, binary, unsupported and unreadable files", async () => {
    const result = await reviewSecretFiles([
      file("ok.txt"),
      file("large.txt", "", { size: 1_000_001 }),
      file("binary.txt", "header\u0000bytes"),
      file("photo.png"),
      file("locked.txt", "", {
        text: async () => {
          throw new Error("private path")
        },
      }),
    ])
    expect(result[0]).toContain("5 selected; 1 scanned; 4 skipped. Partial review")
    expect(result.join(" ")).toContain("locked.txt: could not be read")
    expect(result.join(" ")).not.toContain("private path")
    expect(result.at(-1)).toContain("scanned text files")
  })
  it("redacts patterns while including dot-env and UTF-8 source files", async () => {
    const secret = "SYNTHETICFIXTURE0123456789"
    const result = await reviewSecretFiles([
      file(".env.local", `password=${secret}`),
      file("app.ts", "const label = 'café'"),
    ])
    expect(result[0]).toBe("2 selected; 2 scanned; 0 skipped.")
    expect(result.join(" ")).toContain("possible Assigned credential")
    expect(result.join(" ")).not.toContain(secret)
    expect(result.join(" ")).not.toContain("No high-confidence")
  })
  it("does not describe an unreviewed selection as clear", async () => {
    expect((await reviewSecretFiles([file("a.exe")])).join(" ")).not.toContain("No high-confidence")
    expect((await reviewSecretFiles([]))[0]).toContain("No files selected")
  })
})

describe("editorial consistency", () => {
  it("keeps the publication day consistent across short and full date labels", () => {
    const date = new Date("2026-10-23T20:00:00Z")
    expect(formatBlogDate(date)).toBe("Oct 24, 2026")
    expect(formatBlogDate(date, "long")).toBe("October 24, 2026")
  })
  it("uses one existing editorial topic without removing secondary tags", () => {
    const data = {
      heroImage: { id: "access-boundary-01" },
      tags: ["vibe-coding-security", "access-control", "verification"] as const,
    }
    expect(primaryBlogTopic(data)).toBe("access-control")
    expect(data.tags).toHaveLength(3)
    expect(
      primaryBlogTopic({ heroImage: { id: "unknown" }, tags: ["agent-security", "verification"] })
    ).toBe("agent-security")
  })
})
