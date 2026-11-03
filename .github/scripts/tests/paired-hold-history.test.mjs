import assert from "node:assert/strict"
import test from "node:test"
import { prepareTransition, applyTransition, validateAnchor } from "../paired-hold-history.mjs"
import { pairedReleaseReceipt } from "../../../ops/monitoring/paired-release-hold.mjs"
const hash = (c) => c.repeat(64)
const receipt = (owner) =>
  pairedReleaseReceipt(owner, "a".repeat(40), "b".repeat(40), "sha256:" + hash("c"))
const input = {
  operation: "acquire",
  epoch: hash("d"),
  authority: hash("e"),
  intent: hash("f"),
  nextReceipt: receipt("10:1"),
}
const first = prepareTransition(null, input)
const anchor = JSON.parse(first.anchor)
for (const edit of [
  { seq: true },
  { seq: 257 },
  { v: true },
  { head: "bad" },
  { receipt: "{}" },
  { extra: true },
])
  test("reject invalid anchor " + Object.keys(edit), () =>
    assert.throws(() => validateAnchor({ ...anchor, ...edit }))
  )
for (const edit of [
  { operation: "adopt" },
  { epoch: "bad" },
  { intent: "bad" },
  { authority: "bad" },
  { nextReceipt: "{}" },
  { expiresAtMs: 1 },
])
  test("reject invalid transition " + Object.keys(edit), () =>
    assert.throws(() => prepareTransition(null, { ...input, ...edit }))
  )
test("new origin is distinct; closed history retains sequence and hash", () => {
  const close = prepareTransition(anchor, {
    ...input,
    operation: "release",
    intent: hash("1"),
    nextReceipt: "",
  })
  const p = JSON.parse(close.anchor)
  assert.throws(() => prepareTransition(p, { ...input, intent: hash("2") }))
  const newer = prepareTransition(p, { ...input, epoch: hash("2"), intent: hash("3") })
  assert.equal(JSON.parse(newer.anchor).seq, 3)
  assert.equal(JSON.parse(newer.entry).previous, p.head)
})
test("arbitrary mutated command cannot invoke Redis", async () => {
  let calls = 0
  const redis = {
    eval: () => {
      calls++
      throw new Error("must not execute")
    },
  }
  await assert.rejects(
    applyTransition(redis, { ...first, entry: first.entry.replace('"seq":1', '"seq":2') })
  )
  assert.equal(calls, 0)
})
test("same-owner rebind and capacity overflow cannot dispatch", () => {
  assert.throws(() =>
    prepareTransition(anchor, { ...input, operation: "rebind", nextReceipt: input.nextReceipt })
  )
  assert.throws(() =>
    prepareTransition({ ...anchor, seq: 256 }, { ...input, operation: "release", nextReceipt: "" })
  )
})
test("mutable caller commands cannot change an admitted transition across an await", async () => {
  const inputCommand = { ...first }
  const admitted = { ...first }
  let calls = 0
  const redis = {
    eval: async (_lua, ...args) => {
      calls++
      if (calls === 1) {
        inputCommand.anchor = "changed"
        inputCommand.entry = "changed"
        return ["", -2, "", -2, []]
      }
      if (calls === 2) {
        assert.equal(args[4], admitted.entry)
        assert.equal(args[5], admitted.anchor)
        return admitted.anchor
      }
      return [anchor.receipt, -1, admitted.anchor, -1, [admitted.entry]]
    },
  }
  await applyTransition(redis, inputCommand)
  assert.equal(calls, 3)
})
