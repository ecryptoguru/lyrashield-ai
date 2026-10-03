import assert from "node:assert/strict"
import { test } from "vitest"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { collectSizeDebt, findSizeRegressions, findStaleSizeBaseline } from "./size-ratchet.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("size debt metrics track counts and aggregate excess by file and rule", () => {
  const { metrics, errors } = collectSizeDebt([
    {
      filePath: path.join(root, "apps/web/src/page.tsx"),
      errorCount: 0,
      messages: [
        {
          ruleId: "max-lines-per-function",
          line: 10,
          message: "Function 'Page' has too many lines (170). Maximum allowed is 150.",
        },
        {
          ruleId: "max-lines-per-function",
          line: 50,
          message: "Function 'Other' has too many lines (160). Maximum allowed is 150.",
        },
        {
          ruleId: "max-lines",
          line: 1,
          message: "File has too many lines (610). Maximum allowed is 600.",
        },
      ],
    },
  ])
  assert.deepEqual(errors, [])
  assert.deepEqual(metrics["apps/web/src/page.tsx|max-lines-per-function"], {
    count: 2,
    totalExcess: 30,
    maxExcess: 20,
  })
  assert.deepEqual(metrics["apps/web/src/page.tsx|max-lines"], {
    count: 1,
    totalExcess: 10,
    maxExcess: 10,
  })
})

test("size ratchet accepts shrinkage and rejects new or growing debt", () => {
  const baseline = {
    "apps/web/src/page.tsx|max-lines-per-function": {
      count: 2,
      totalExcess: 30,
      maxExcess: 20,
    },
  }
  assert.deepEqual(
    findSizeRegressions(baseline, {
      "apps/web/src/page.tsx|max-lines-per-function": {
        count: 1,
        totalExcess: 10,
        maxExcess: 10,
      },
    }),
    []
  )
  assert.equal(
    findSizeRegressions(baseline, {
      "apps/web/src/page.tsx|max-lines-per-function": {
        count: 2,
        totalExcess: 31,
        maxExcess: 21,
      },
    }).length,
    2
  )
  assert.match(
    findSizeRegressions(baseline, {
      "apps/web/src/new.ts|max-lines": { count: 1, totalExcess: 1, maxExcess: 1 },
    })[0],
    /new oversized/
  )
})

test("size baseline must be refreshed when debt shrinks", () => {
  const baseline = {
    "apps/web/src/page.tsx|max-lines-per-function": {
      count: 2,
      totalExcess: 30,
      maxExcess: 20,
    },
  }
  assert.deepEqual(
    findStaleSizeBaseline(baseline, {
      "apps/web/src/page.tsx|max-lines-per-function": {
        count: 2,
        totalExcess: 30,
        maxExcess: 20,
      },
    }),
    []
  )
  assert.ok(
    findStaleSizeBaseline(baseline, {
      "apps/web/src/page.tsx|max-lines-per-function": {
        count: 1,
        totalExcess: 10,
        maxExcess: 10,
      },
    }).length > 0
  )
})
