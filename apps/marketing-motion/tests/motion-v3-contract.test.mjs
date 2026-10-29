import assert from "node:assert/strict"
import test from "node:test"
import {
  MOTION_VERSION,
  MOTION_DURATION,
  MOTION_CHAPTER_DURATION,
  MOTION_VARIANTS,
  motionPublishRoot,
} from "../scripts/motion-media-contract.mjs"

test("continuous v3 media has one shared eight-second chapter contract", () => {
  assert.equal(MOTION_VERSION, "3")
  assert.equal(MOTION_DURATION, 56)
  assert.equal(MOTION_CHAPTER_DURATION, 8)
  assert.equal(motionPublishRoot("0123456789abcdef"), "assurance-world/v3/0123456789abcdef")
})
test("desktop and portrait delivery have variant decode budgets", () => {
  assert.deepEqual([MOTION_VARIANTS.desktop.width, MOTION_VARIANTS.desktop.height], [1440, 810])
  assert.equal(MOTION_VARIANTS.desktop.gop, 2)
  assert.equal(MOTION_VARIANTS.portrait.gop, 4)
  assert.ok(MOTION_VARIANTS.portrait.width < MOTION_VARIANTS.portrait.height)
})
