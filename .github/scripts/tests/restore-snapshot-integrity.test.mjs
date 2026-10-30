import test from "node:test"
import assert from "node:assert/strict"
import { copySnapshot, verifySnapshot } from "../restore-snapshot-integrity.mjs"
const sha = "a".repeat(64)
const sql = (rows) => [
  "-- Data only",
  'COPY public."Workspace" (id, name) FROM stdin;',
  ...rows,
  "\\.",
  'COPY public."Scan" (id) FROM stdin;',
  "\\.",
]
test("private snapshot binds exact dump and compares rows including duplicates without row-order assumptions", async () => {
  const expected = await copySnapshot(sql(["a\tprivate\\nrow", "b\tother", "b\tother"]), sha)
  const actual = await copySnapshot(sql(["b\tother", "a\tprivate\\nrow", "b\tother"]), sha)
  verifySnapshot(expected, actual)
  assert.equal(expected.tables['public."Workspace"'].count, 3)
  for (const rows of [
    ["b\tother", "a\tprivate\\nCHANGED", "b\tother"],
    ["b\tother", "a\tprivate\\nrow"],
  ]) {
    const changed = await copySnapshot(sql(rows), sha)
    assert.throws(() => verifySnapshot(expected, changed), /mismatch/)
  }
  assert.throws(
    () => verifySnapshot(expected, { ...actual, dumpSha256: "b".repeat(64) }),
    /mismatch/
  )
  assert.equal(JSON.stringify(expected).includes("private"), false)
})
test("snapshot fails closed on malformed, duplicate, missing or truncated COPY blocks", async () => {
  for (const lines of [
    [],
    ["COPY malformed;"],
    ['COPY public."Scan" (id) FROM stdin;', "row"],
    [...sql([]), ...sql([])],
  ])
    await assert.rejects(copySnapshot(lines, sha))
  await assert.rejects(copySnapshot(sql([]), "invalid"))
})
