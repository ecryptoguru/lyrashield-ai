import assert from "node:assert/strict"
import test from "node:test"
import { selectExactRevision } from "../finalize-held-webhook-recovery.mjs"

const IMAGE = `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-web@sha256:${"a".repeat(64)}`
const OTHER = `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-web@sha256:${"b".repeat(64)}`

function revision(name, image, active) {
  return { name, properties: { active, template: { containers: [{ image }] } } }
}

test("selects a single exact prepared revision when all writers are inactive", () => {
  const inventory = [revision("old--1", OTHER, false), revision("candidate--2", IMAGE, false)]
  assert.equal(selectExactRevision(inventory, IMAGE), "candidate--2")
})

test("accepts an already active exact candidate for post-release reentry", () => {
  const inventory = [revision("old--1", OTHER, false), revision("candidate--2", IMAGE, true)]
  assert.equal(selectExactRevision(inventory, IMAGE), "candidate--2")
})

test("rejects foreign active writers and ambiguous exact candidates", () => {
  assert.throws(() =>
    selectExactRevision(
      [revision("old--1", OTHER, true), revision("candidate--2", IMAGE, false)],
      IMAGE
    )
  )
  assert.throws(() =>
    selectExactRevision(
      [revision("candidate--1", IMAGE, false), revision("candidate--2", IMAGE, true)],
      IMAGE
    )
  )
  assert.throws(() => selectExactRevision([revision("old--1", OTHER, false)], IMAGE))
})

test("closure can identify only the exact prepared revision even when a foreign writer is active", () => {
  const inventory = [revision("foreign--1", OTHER, true), revision("candidate--2", IMAGE, true)]
  assert.equal(selectExactRevision(inventory, IMAGE, true), "candidate--2")
  assert.throws(() =>
    selectExactRevision([...inventory, revision("candidate--3", IMAGE, false)], IMAGE, true)
  )
})

test("rejects malformed Azure inventory and revision names", () => {
  assert.throws(() => selectExactRevision([], IMAGE))
  assert.throws(() => selectExactRevision([revision("bad/revision", IMAGE, false)], IMAGE))
  assert.throws(() =>
    selectExactRevision([{ name: "candidate", properties: { active: "false" } }], IMAGE)
  )
})
