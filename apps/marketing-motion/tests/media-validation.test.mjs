import assert from "node:assert/strict"
import test from "node:test"
import {
  assertFaststartBytes,
  assertGopFrames,
  assertDuration,
} from "../scripts/media-validation.mjs"
const box = (type, payload = Buffer.alloc(0)) => {
  const data = Buffer.alloc(8 + payload.length)
  data.writeUInt32BE(data.length)
  data.write(type, 4)
  payload.copy(data, 8)
  return data
}
test("faststart parses container boxes instead of coincidental payload strings", () => {
  assert.doesNotThrow(() =>
    assertFaststartBytes(Buffer.concat([box("ftyp"), box("moov"), box("mdat")]))
  )
  assert.throws(
    () =>
      assertFaststartBytes(
        Buffer.concat([box("ftyp", Buffer.from("moov")), box("mdat"), box("moov")])
      ),
    /faststart/
  )
  assert.throws(
    () => assertFaststartBytes(Buffer.from([0, 0, 0, 20, 109, 111, 111, 118])),
    /Malformed/
  )
  assert.throws(() => assertFaststartBytes(box("moov")), /faststart/)
})
test("GOP validation covers first, intermediate and final boundaries", () => {
  const frames = (length, keys) =>
    Array.from({ length }, (_, index) => ({ key_frame: keys.includes(index) ? 1 : 0 }))
  assert.doesNotThrow(() => assertGopFrames(frames(12, [0, 4, 8]), 4))
  assert.throws(() => assertGopFrames(frames(12, [1, 5, 9]), 4), /GOP/)
  assert.throws(() => assertGopFrames(frames(12, [0, 5, 9]), 4), /GOP/)
  assert.throws(() => assertGopFrames(frames(13, [0, 4, 8]), 4), /GOP/)
  assert.throws(() => assertGopFrames([], 4), /GOP/)
})
test("duration validation uses the authored frame tolerance", () => {
  assert.doesNotThrow(() => assertDuration(56, 56, 30))
  assert.doesNotThrow(() => assertDuration(56.03, 56, 30))
  assert.throws(() => assertDuration(56.04, 56, 30), /duration/)
  assert.throws(() => assertDuration(NaN, 56, 30), /duration/)
})
