import { describe, expect, it } from "vitest"

import { validatePatchDiff, diffChecksum } from "./index"
import { patchScopeForPlan } from "./scope-policy"
import { applyUnifiedDiff, extractFileDiff } from "./apply-diff"
import { buildUnifiedDiff } from "./build-diff"

const STARTER = patchScopeForPlan("STARTER")
const LAUNCH = patchScopeForPlan("LAUNCH_ASSURANCE")

function diffFor(path: string, added: string[], removed: string[] = []): string {
  const body = [...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join("\n")
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,1 +1,1 @@",
    body,
  ].join("\n")
}

describe("patchScopeForPlan (founder decision: plan-tiered)", () => {
  it("Starter is current-file-only with a 100-line cap", () => {
    expect(patchScopeForPlan("STARTER")).toEqual({
      pathScope: "current-file",
      maxLinesTouched: 100,
    })
  })
  it("all paid plans at or above Pro get the implicated set with a 200-line cap", () => {
    expect(patchScopeForPlan("PRO")).toEqual({ pathScope: "implicated-set", maxLinesTouched: 200 })
    expect(patchScopeForPlan("LAUNCH_ASSURANCE")).toEqual({
      pathScope: "implicated-set",
      maxLinesTouched: 200,
    })
    expect(patchScopeForPlan("TEAM")).toEqual({
      pathScope: "implicated-set",
      maxLinesTouched: 200,
    })
    expect(patchScopeForPlan("AGENCY").maxLinesTouched).toBe(200)
    expect(patchScopeForPlan("BUSINESS").maxLinesTouched).toBe(200)
    expect(patchScopeForPlan("ENTERPRISE").maxLinesTouched).toBe(200)
  })
  it("unknown, free and trial plans fail closed to the strictest tier (current-file, 100)", () => {
    expect(patchScopeForPlan("NOPE")).toEqual({ pathScope: "current-file", maxLinesTouched: 100 })
    expect(patchScopeForPlan("")).toEqual({ pathScope: "current-file", maxLinesTouched: 100 })
    expect(patchScopeForPlan("FREE")).toEqual({ pathScope: "current-file", maxLinesTouched: 100 })
    expect(patchScopeForPlan("TRIAL")).toEqual({ pathScope: "current-file", maxLinesTouched: 100 })
  })
})

describe("validatePatchDiff — scope", () => {
  it("accepts an in-scope, in-place edit", () => {
    const r = validatePatchDiff(
      diffFor("src/auth.ts", ["const ok = true"]),
      "src/auth.ts",
      [],
      STARTER
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.filesTouched).toEqual(["src/auth.ts"])
  })

  it("Starter rejects a second file even if implicated", () => {
    const diff = diffFor("src/a.ts", ["x"]) + "\n" + diffFor("src/b.ts", ["y"])
    const r = validatePatchDiff(diff, "src/a.ts", ["src/b.ts"], STARTER)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("PATH_OUT_OF_SCOPE")
  })

  it("Launch Assurance allows the implicated set", () => {
    const diff = diffFor("src/a.ts", ["x"]) + "\n" + diffFor("src/b.ts", ["y"])
    const r = validatePatchDiff(diff, "src/a.ts", ["src/b.ts"], LAUNCH)
    expect(r.ok).toBe(true)
  })

  it("rejects a path outside the implicated set on any plan", () => {
    const r = validatePatchDiff(diffFor("src/evil.ts", ["x"]), "src/a.ts", ["src/b.ts"], LAUNCH)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("PATH_OUT_OF_SCOPE")
  })
})

describe("validatePatchDiff — forbidden content", () => {
  it("rejects .github/ writes (CI/auth surface)", () => {
    const r = validatePatchDiff(
      diffFor(".github/workflows/x.yml", ["on: push"]),
      "src/a.ts",
      ["src/a.ts"],
      LAUNCH
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("FORBIDDEN_PATH")
  })

  it("rejects lockfile edits", () => {
    const r = validatePatchDiff(
      diffFor("pnpm-lock.yaml", ["x"]),
      "src/a.ts",
      ["src/a.ts", "pnpm-lock.yaml"],
      LAUNCH
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("LOCKFILE_NOT_ALLOWED")
  })

  it("rejects secret-shaped added lines", () => {
    const r = validatePatchDiff(
      diffFor("src/a.ts", ['const k = "sk-abcdefghijabcdefghij"']),
      "src/a.ts",
      [],
      LAUNCH
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("SECRET_LIKE_CONTENT")
  })

  it("rejects file deletion", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "deleted file mode 100644",
      "--- a/src/a.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-x",
    ].join("\n")
    const r = validatePatchDiff(diff, "src/a.ts", [], LAUNCH)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("DELETE_NOT_ALLOWED")
  })

  it("rejects new file creation under current-file scope", () => {
    const diff = [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1 @@",
      "+x",
    ].join("\n")
    const r = validatePatchDiff(diff, "src/new.ts", [], STARTER)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("NEW_FILE_OUT_OF_SCOPE")
  })

  it("rejects new file creation even on implicated-set plans (executor cannot apply them)", () => {
    // Regression guard: the v1 executor reads the target file at the scanned
    // base commit and applies the diff to it — a file absent at that commit
    // always fails at execution time. Validation must reject before approval.
    const diff = [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1 @@",
      "+x",
    ].join("\n")
    const r = validatePatchDiff(diff, "src/a.ts", ["src/a.ts", "src/new.ts"], LAUNCH)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("NEW_FILE_OUT_OF_SCOPE")
  })
})

describe("validatePatchDiff — limits and fail-closed", () => {
  it("enforces the line cap", () => {
    const many = Array.from({ length: 101 }, (_, i) => `line ${i}`)
    const r = validatePatchDiff(diffFor("src/a.ts", many), "src/a.ts", [], STARTER)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("TOO_MANY_LINES")
  })

  it("rejects an empty diff", () => {
    expect(validatePatchDiff("", "src/a.ts", [], LAUNCH).ok).toBe(false)
    expect(validatePatchDiff("   \n", "src/a.ts", [], LAUNCH).code).toBe("EMPTY_DIFF")
  })

  it("rejects a non-diff (fail-closed)", () => {
    const r = validatePatchDiff("this is not a diff at all", "src/a.ts", [], LAUNCH)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(["UNPARSEABLE", "EMPTY_DIFF"]).toContain(r.code)
  })
})

describe("diffChecksum — the approval binding anchor", () => {
  it("changes when the diff changes (tamper-evident)", () => {
    const a = diffChecksum(diffFor("src/a.ts", ["x"]))
    const b = diffChecksum(diffFor("src/a.ts", ["y"]))
    expect(a).not.toBe(b)
  })
  it("is stable for identical diffs", () => {
    expect(diffChecksum(diffFor("src/a.ts", ["x"]))).toBe(diffChecksum(diffFor("src/a.ts", ["x"])))
  })
})

describe("applyUnifiedDiff — safe, legible application (T5)", () => {
  it("applies a one-line change at the correct position", () => {
    const original = "line1\nline2\nline3\nline4\n"
    const diff = [
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -2,2 +2,2 @@",
      "-line2",
      "+LINE2",
      " line3",
    ].join("\n")
    expect(applyUnifiedDiff(original, extractFileDiff(diff, "f.ts"))).toBe(
      "line1\nLINE2\nline3\nline4\n"
    )
  })

  it("fails closed on a context mismatch (never half-applies)", () => {
    const diff = [
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,1 +1,1 @@",
      "-expected",
      "+changed",
    ].join("\n")
    expect(() => applyUnifiedDiff("actual\ncontent\n", extractFileDiff(diff, "f.ts"))).toThrow()
  })

  it("applies a pure addition (no removals)", () => {
    const original = "a\nb\n"
    const diff = [
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,2 +1,3 @@",
      " a",
      "+inserted",
      " b",
    ].join("\n")
    expect(applyUnifiedDiff(original, extractFileDiff(diff, "f.ts"))).toBe("a\ninserted\nb\n")
  })
})

describe("buildUnifiedDiff — the producer's diff builder", () => {
  it("produces a diff that round-trips: apply(before, build(before,after)) === after", () => {
    const before = "const a = 1\nconst b = unsafe(input)\nconst c = 3\n"
    const after = "const a = 1\nconst b = sanitize(input)\nconst c = 3\n"
    const diff = buildUnifiedDiff("src/a.ts", before, after)
    expect(diff).toContain("diff --git a/src/a.ts b/src/a.ts")
    // The whole point: the generated diff applies cleanly and yields `after`.
    expect(applyUnifiedDiff(before, extractFileDiff(diff, "src/a.ts"))).toBe(after)
  })

  it("the generated diff passes the validator for its own file", () => {
    const before = "x\ny\nz\n"
    const after = "x\nY\nz\n"
    const diff = buildUnifiedDiff("src/a.ts", before, after)
    const r = validatePatchDiff(diff, "src/a.ts", [], LAUNCH)
    expect(r.ok).toBe(true)
  })

  it("returns empty for identical content", () => {
    expect(buildUnifiedDiff("src/a.ts", "same\n", "same\n")).toBe("")
  })
})
