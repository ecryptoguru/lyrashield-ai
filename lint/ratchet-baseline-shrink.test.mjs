import assert from "node:assert/strict"
import { test } from "vitest"
import { checkCopyBaselineShrink, checkSizeBaselineShrink } from "./ratchet-baseline-shrink.mjs"

test("ratchet baselines permit only removal or reduction of existing debt", () => {
  const previousSize = {
    metrics: { "a.ts|max-lines": { count: 2, totalExcess: 20, maxExcess: 12 } },
  }
  assert.deepEqual(
    checkSizeBaselineShrink(previousSize, {
      metrics: { "a.ts|max-lines": { count: 1, totalExcess: 8, maxExcess: 8 } },
    }),
    []
  )
  assert.ok(
    checkSizeBaselineShrink(previousSize, {
      metrics: { "a.ts|max-lines": { count: 2, totalExcess: 21, maxExcess: 13 } },
    }).length > 0
  )

  const previousCopy = {
    version: 1,
    roots: ["docs"],
    files: { "docs/a.md": { abc: 2, def: 1 } },
  }
  assert.deepEqual(
    checkCopyBaselineShrink(previousCopy, {
      version: 1,
      roots: ["docs"],
      files: { "docs/a.md": { renamedLine: 2 } },
    }),
    []
  )
  assert.ok(
    checkCopyBaselineShrink(previousCopy, {
      version: 1,
      roots: ["docs"],
      files: { "docs/a.md": { xyz: 4 } },
    }).length > 0
  )
  assert.ok(
    checkCopyBaselineShrink(previousCopy, {
      version: 1,
      roots: ["docs"],
      files: { "docs/new.md": { xyz: 1 } },
    }).length > 0
  )
})
