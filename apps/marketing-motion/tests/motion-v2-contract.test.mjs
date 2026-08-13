import assert from "node:assert/strict"
import test from "node:test"
import {
  MOTION_CHAPTERS,
  MOTION_CHAPTER_DURATION,
  MOTION_DURATION,
  MOTION_FPS,
  MOTION_GOP,
  MOTION_VARIANTS,
  MOTION_VERSION,
  motionPosterRelativePath,
  motionPublishRoot,
  motionTrackRelativePath,
} from "../scripts/motion-media-contract.mjs"

test("defines one continuous H.264 track per aspect ratio", () => {
  assert.equal(MOTION_VERSION, "2")
  assert.equal(MOTION_DURATION, 42)
  assert.equal(MOTION_FPS, 30)
  assert.equal(MOTION_GOP, 6)
  assert.equal(MOTION_CHAPTER_DURATION, 6)
  assert.deepEqual(
    Object.entries(MOTION_VARIANTS).map(
      ([variant, { width, height, budgetBytes, masterWidth, masterHeight }]) => [
        variant,
        width,
        height,
        budgetBytes,
        masterWidth,
        masterHeight,
      ]
    ),
    [
      ["desktop", 1600, 900, 8 * 1024 * 1024, 1920, 1080],
      ["portrait", 720, 1280, 5 * 1024 * 1024, 1080, 1920],
    ]
  )
  assert.equal(motionTrackRelativePath("desktop"), "desktop/assurance-world.mp4")
  assert.equal(motionTrackRelativePath("portrait"), "portrait/assurance-world.mp4")
  assert.throws(() => motionTrackRelativePath("square"), /Unknown motion variant/)
  assert.throws(() => motionPosterRelativePath("intro", "desktop"), /Unknown motion chapter/)
})

test("keeps seven chapter posters and immutable v2 publication paths", () => {
  assert.deepEqual(MOTION_CHAPTERS, [
    "gateway",
    "target",
    "scan",
    "evidence-state",
    "fix-proposal",
    "retest",
    "report",
  ])
  assert.equal(
    motionPosterRelativePath("evidence-state", "portrait"),
    "posters/evidence-state-portrait.webp"
  )
  assert.equal(motionPublishRoot("0123456789abcdef"), "assurance-world/v2/0123456789abcdef")
  assert.throws(() => motionPublishRoot("latest"), /16 lowercase hex/)
})
