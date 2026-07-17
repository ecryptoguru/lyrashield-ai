import { describe, it, expect } from "vitest"
import { buttonVariants } from "./button"
import { badgeVariants } from "./badge"
import { cn } from "./utils"

describe("buttonVariants", () => {
  it("applies default variant classes", () => {
    const cls = buttonVariants()
    expect(cls).toContain("rounded-[2px]")
    expect(cls).toContain("inline-flex")
    expect(cls).toContain("bg-primary")
    expect(cls).toContain("shadow-sm")
  })

  it("applies secondary variant classes", () => {
    const cls = buttonVariants({ variant: "secondary" })
    expect(cls).toContain("border")
    expect(cls).toContain("bg-card")
    expect(cls).toContain("shadow-xs")
  })

  it("applies ghost variant classes", () => {
    const cls = buttonVariants({ variant: "ghost" })
    expect(cls).toContain("hover:bg-accent")
    expect(cls).not.toContain("gradient-primary")
  })

  it("applies destructive variant classes", () => {
    const cls = buttonVariants({ variant: "destructive" })
    expect(cls).toContain("bg-destructive")
    expect(cls).toContain("text-destructive-foreground")
  })

  it("applies outline variant classes", () => {
    const cls = buttonVariants({ variant: "outline" })
    expect(cls).toContain("border")
    expect(cls).toContain("bg-transparent")
  })

  it("applies size sm classes", () => {
    const cls = buttonVariants({ size: "sm" })
    expect(cls).toContain("h-11")
    expect(cls).toContain("px-3")
    expect(cls).toContain("text-xs")
  })

  it("applies size md classes", () => {
    const cls = buttonVariants({ size: "md" })
    expect(cls).toContain("h-11")
    expect(cls).toContain("px-4")
  })

  it("applies size lg classes", () => {
    const cls = buttonVariants({ size: "lg" })
    expect(cls).toContain("h-12")
    expect(cls).toContain("px-6")
    expect(cls).toContain("text-base")
  })

  it("applies size icon classes", () => {
    const cls = buttonVariants({ size: "icon" })
    expect(cls).toContain("size-11")
  })

  it("includes active press feedback", () => {
    const cls = buttonVariants()
    expect(cls).toContain("active:scale-[0.98]")
  })

  it("includes focus-visible ring", () => {
    const cls = buttonVariants()
    expect(cls).toContain("focus-visible:ring-2")
  })
})

describe("badgeVariants", () => {
  it("applies default variant classes", () => {
    const cls = badgeVariants()
    expect(cls).toContain("rounded-full")
    expect(cls).toContain("bg-secondary")
    expect(cls).toContain("text-secondary-foreground")
  })

  it("applies success variant classes", () => {
    const cls = badgeVariants({ variant: "success" })
    expect(cls).toContain("bg-emerald-500/10")
    expect(cls).toContain("text-emerald-600")
  })

  it("applies danger variant classes", () => {
    const cls = badgeVariants({ variant: "danger" })
    expect(cls).toContain("bg-destructive/10")
    expect(cls).toContain("text-destructive")
  })

  it("applies warning variant classes", () => {
    const cls = badgeVariants({ variant: "warning" })
    expect(cls).toContain("bg-amber-500/10")
    expect(cls).toContain("text-amber-600")
  })

  it("applies info variant classes", () => {
    const cls = badgeVariants({ variant: "info" })
    expect(cls).toContain("bg-sky-500/10")
    expect(cls).toContain("text-sky-600")
  })

  it("applies muted variant classes", () => {
    const cls = badgeVariants({ variant: "muted" })
    expect(cls).toContain("bg-muted")
    expect(cls).toContain("text-muted-foreground")
  })
})

describe("cn", () => {
  it("merges class names", () => {
    expect(cn("foo", "bar")).toBe("foo bar")
  })

  it("handles conditional classes", () => {
    expect(cn("base", false && "hidden", "visible")).toBe("base visible")
  })

  it("deduplicates conflicting tailwind classes", () => {
    const result = cn("px-3", "px-4")
    expect(result).toBe("px-4")
  })
})
