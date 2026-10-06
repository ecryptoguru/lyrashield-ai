import assert from "node:assert/strict"
import { test } from "vitest"
import {
  findCopyBaselineGrowth,
  findCopyRegressions,
  findStaleCopyBaseline,
  scanText,
  validateCopyBaselineRefresh,
} from "./serial-comma-ratchet.mjs"

test("copy scan flags an unambiguous list but excludes a clause-joining comma", () => {
  const list = "Plans include Starter, Pro, and Agency."
  const clause = "Plans include Starter, Pro, and Agency, and the customer can upgrade."
  const clauseOnly = "The company tracks setup, access, and it sends status updates."
  const andAlsoClause =
    "Auggie plugins support skills, commands, rules, hooks and MCP, and also accept Claude Code plugin layouts."
  const alternativeClause =
    "In Qoder IDE, open Extensions to add a custom MCP server, or use the Plugins menu to import a package."
  const documentedClause =
    "VS Code has a documented config path, no generated shim exists, and the documented legacy entry remains available."
  const possessiveClause =
    "Registry has a config path, no generated shim exists, and its plugin discovery path lacks runtime proof."

  assert.equal(scanText(list).size, 1)
  assert.equal(scanText(clauseOnly).size, 0)
  assert.equal(scanText(clause).size, 1)
  assert.equal(scanText(andAlsoClause).size, 0)
  assert.equal(scanText(alternativeClause).size, 0)
  assert.equal(scanText(documentedClause).size, 0)
  assert.equal(scanText(possessiveClause).size, 0)

  const baseline = { "apps/marketing/copy.md": Object.fromEntries(scanText("Existing copy.")) }
  const introducedList = {
    "apps/marketing/copy.md": Object.fromEntries(scanText(list)),
  }
  assert.match(findCopyRegressions(baseline, introducedList)[0], /new or increased/)
})

test("copy baseline accepts removals and rejects new lines or repeated candidates", () => {
  const keep = "keep alpha, keep beta, and keep gamma\n"
  const remove = "remove alpha, remove beta, or remove gamma\n"
  const existing = scanText(keep + remove)
  const reduced = scanText(keep)
  assert.deepEqual(
    findCopyRegressions(
      { "docs/a.md": Object.fromEntries(existing) },
      { "docs/a.md": Object.fromEntries(reduced) }
    ),
    []
  )
  assert.match(
    findCopyRegressions(
      { "docs/a.md": Object.fromEntries(existing) },
      {
        "docs/a.md": Object.fromEntries(scanText(keep + "new alpha, new beta, or new gamma\n")),
      }
    )[0],
    /new or increased/
  )
  assert.match(
    findCopyRegressions(
      { "docs/a.md": Object.fromEntries(existing) },
      { "docs/new.md": Object.fromEntries(scanText("new alpha, new beta, or new gamma\n")) }
    )[0],
    /new serial-comma candidate/
  )
})

test("copy baseline must be refreshed after a matching line is removed", () => {
  const baseline = {
    "docs/a.md": Object.fromEntries(
      scanText(
        "keep alpha, keep beta, and keep gamma\nremove alpha, remove beta, or remove gamma\n"
      )
    ),
  }
  const current = {
    "docs/a.md": Object.fromEntries(scanText("keep alpha, keep beta, and keep gamma\n")),
  }
  assert.ok(findCopyRegressions(baseline, current).length === 0)
  assert.ok(findStaleCopyBaseline(baseline, current).length > 0)
})

test("baseline refresh compares per-file candidate counts and requires a net reduction", () => {
  const baseline = { "docs/a.md": { abc: 2, def: 1 } }
  assert.deepEqual(findCopyBaselineGrowth(baseline, { "docs/a.md": { xyz: 2 } }), [])
  assert.deepEqual(validateCopyBaselineRefresh(baseline, { "docs/a.md": { xyz: 2 } }), [])
  assert.match(
    findCopyBaselineGrowth(baseline, { "docs/a.md": { xyz: 4 } })[0],
    /candidate count grew from 3 to 4/
  )
  assert.match(
    validateCopyBaselineRefresh(baseline, { "docs/a.md": { xyz: 3 } })[0],
    /candidate total must shrink/
  )
})
