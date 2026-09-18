import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("manual repository target form", () => {
  // apps/web has no component test harness; preserve the exact-ref UI/request
  // contract here. The screen is split across a coordinator (targets-client.tsx)
  // plus form/table views, so contract greps read all of them.
  const source = ["targets-client.tsx", "targets-form.tsx", "targets-table.tsx"]
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    .map((file) => readFileSync(new URL(`./${file}`, import.meta.url), "utf8"))
    .join("\n")

  it("exposes an accessible optional branch or tag input", () => {
    expect(source).toContain('label="Branch or tag (optional)" htmlFor="repo-ref"')
    expect(source).toContain('id="repo-ref-help"')
    expect(source).toContain('aria-describedby="repo-ref-help"')
    expect(source).toContain("exact branch or release")
  })

  it("sends a trimmed exact ref through the existing target request", () => {
    expect(source).toContain(
      "...(repoForm.branch.trim() ? { branch: repoForm.branch.trim() } : {}),"
    )
  })

  it("keeps domain verification and screen-reader fallback cells visible to assistive technology", () => {
    expect(source).toContain("Domain verification")
    expect(source).toContain("Not applicable")
    expect(source).toContain('<th scope="col" className="sr-only">')
    expect(source).toContain('<td className="sr-only">')
    expect(source).not.toContain('<td className="hidden">')
  })
})

describe("targets table responsive contract (UF-28)", () => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const table = readFileSync(new URL("./targets-table.tsx", import.meta.url), "utf8")

  it("only applies the 640px floor once the columns it protects are shown", () => {
    // A fixed min-width at every breakpoint is what pushed 281px of table
    // outside a 359px phone card.
    expect(table).toContain('className="w-full min-w-0 text-sm sm:min-w-[40rem]"')
    expect(table).not.toContain('className="w-full min-w-[40rem] text-sm"')
  })

  it("shows Status and yields Domain verification below sm", () => {
    // Status is a lifecycle fact; domain verification is self-attested metadata.
    expect(table).toMatch(/<th scope="col" className="[^"]*">\s*Status\s*<\/th>/)
    expect(table).toMatch(
      /<th scope="col" className="[^"]*sm:table-cell">\s*Domain verification\s*<\/th>/
    )
    // The Status column must not carry a breakpoint gate that hides it on phones.
    expect(table).not.toMatch(/<th scope="col" className="[^"]*hidden[^"]*">\s*Status\s*<\/th>/)
  })

  it("keeps the scroll container's keyboard and labelling contract", () => {
    expect(table).toContain("overflow-x-auto")
    expect(table).toContain("tabIndex={0}")
    expect(table).toContain('aria-label="Targets list"')
  })

  it("cues horizontal scroll only while content is hidden to the right", () => {
    expect(table).toContain("useHorizontalOverflow")
    expect(table).toContain("scrollLeft + element.clientWidth < element.scrollWidth - 1")
    expect(table).toContain('data-testid="targets-table-scroll-fade"')
    expect(table).toContain("pointer-events-none absolute inset-y-px right-px w-8")
    expect(table).toContain('overflows ? "opacity-100" : "opacity-0"')
  })
})
