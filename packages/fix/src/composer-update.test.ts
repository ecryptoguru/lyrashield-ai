import { describe, expect, it } from "vitest"
import { buildComposerUpdateDiff, parseComposerFixArtifact } from "./composer-update"
import { diffChecksum } from "./checksum"
import { patchScopeForPlan } from "./scope-policy"
import { validatePatchDiff, validateComposerFixArtifact } from "./diff-validator"

const before =
  JSON.stringify(
    {
      "content-hash": "a".repeat(32),
      packages: [{ name: "psr/log", version: "1.1.3", require: { php: ">=5.3.0" } }],
      "packages-dev": [],
    },
    null,
    4
  ) + "\n"
const after = before.replace('"1.1.3"', '"1.1.4"')
const bindings = {
  workspaceId: "ws-1",
  targetId: "target-1",
  findingId: "finding-1",
  proposalId: "proposal-1",
  baseCommit: "a".repeat(40),
}
function artifact() {
  const diff = buildComposerUpdateDiff("composer.lock", before, after)
  return {
    version: "composer-fix/1" as const,
    ...bindings,
    manifestPath: "composer.json",
    lockPath: "composer.lock",
    packageName: "psr/log",
    fromVersion: "1.1.3",
    toVersion: "1.1.4",
    before,
    after,
    diff,
    diffChecksum: diffChecksum(diff),
    resolverImage: "composer@sha256:" + "b".repeat(64),
    checks: {
      network: "none" as const,
      scripts: false as const,
      plugins: false as const,
      install: false as const,
      lockValidated: true as const,
    },
    compatibility: "customer-tests-required" as const,
  }
}
describe("dedicated Composer update provenance", () => {
  it("allows a scoped resolver-produced upgrade while ordinary patches still reject lockfiles", () => {
    const value = artifact()
    expect(validateComposerFixArtifact(value, bindings, patchScopeForPlan("PRO"))).toMatchObject({
      ok: true,
      filesTouched: ["composer.lock"],
    })
    expect(
      validatePatchDiff(value.diff, "composer.lock", [], patchScopeForPlan("PRO"))
    ).toMatchObject({ ok: false, code: "LOCKFILE_NOT_ALLOWED" })
  })
  it.each(["workspaceId", "targetId", "findingId", "proposalId", "baseCommit"] as const)(
    "rejects a changed %s binding",
    (key) => {
      expect(
        validateComposerFixArtifact(
          artifact(),
          { ...bindings, [key]: key === "baseCommit" ? "c".repeat(40) : "other" },
          patchScopeForPlan("PRO")
        )
      ).toMatchObject({ ok: false })
    }
  )
  it("rejects unbound lockfile changes even with a recomputed diff checksum", () => {
    const value = artifact()
    value.diff = value.diff.replace("1.1.4", "9.0.0")
    value.diffChecksum = diffChecksum(value.diff)
    expect(validateComposerFixArtifact(value, bindings, patchScopeForPlan("PRO"))).toMatchObject({
      ok: false,
    })
  })
  it("rejects unrelated package mutations", () => {
    const value = artifact()
    value.after = value.after.replace(
      '"packages-dev": []',
      '"packages-dev": [{"name":"evil/package","version":"1.0.0"}]'
    )
    value.diff = buildComposerUpdateDiff(value.lockPath, value.before, value.after)
    value.diffChecksum = diffChecksum(value.diff)
    expect(validateComposerFixArtifact(value, bindings, patchScopeForPlan("PRO"))).toMatchObject({
      ok: false,
    })
  })
  it("rejects unsafe paths and parser claims that weaken isolation", () => {
    const value = artifact()
    expect(() =>
      parseComposerFixArtifact(JSON.stringify({ ...value, lockPath: "../composer.lock" }))
    ).toThrow()
    expect(() =>
      parseComposerFixArtifact(
        JSON.stringify({ ...value, checks: { ...value.checks, scripts: true } })
      )
    ).toThrow()
    expect(() =>
      parseComposerFixArtifact(JSON.stringify({ ...value, resolverImage: "composer:latest" }))
    ).toThrow()
  })
  it("preserves the manifest hash and rejects lock metadata tampering", () => {
    const value = artifact()
    value.after = value.after.replace("a".repeat(32), "b".repeat(32))
    value.diff = buildComposerUpdateDiff(value.lockPath, value.before, value.after)
    value.diffChecksum = diffChecksum(value.diff)
    expect(validateComposerFixArtifact(value, bindings, patchScopeForPlan("PRO"))).toMatchObject({
      ok: false,
    })
  })
  it("retains tier line caps and requires an actual version upgrade", () => {
    const value = artifact()
    expect(
      validateComposerFixArtifact(value, bindings, {
        pathScope: "current-file",
        maxLinesTouched: 1,
      })
    ).toMatchObject({ ok: false, code: "TOO_MANY_LINES" })
    value.toVersion = "1.1.3"
    expect(validateComposerFixArtifact(value, bindings, patchScopeForPlan("PRO"))).toMatchObject({
      ok: false,
    })
  })
  it("bounds lockfile diff construction before allocating a large matrix", () => {
    expect(() => buildComposerUpdateDiff("composer.lock", "a".repeat(1024 * 1024), after)).toThrow()
  })
  it("accepts the v prefix recorded in real Composer releases", () => {
    const value = artifact()
    value.before = value.before.replace('"1.1.3"', '"v1.1.3"')
    value.diff = buildComposerUpdateDiff(value.lockPath, value.before, value.after)
    value.diffChecksum = diffChecksum(value.diff)
    expect(validateComposerFixArtifact(value, bindings, patchScopeForPlan("PRO"))).toMatchObject({
      ok: true,
    })
  })
})
