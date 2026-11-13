import assert from "node:assert/strict"
import test from "node:test"
import { PerspectiveCamera, Vector3 } from "three"
import { Raycaster } from "three"
import { createWorld } from "../src/world.ts"
const camera = await import("../src/camera.ts").catch(() => ({}))
test("camera samples are deterministic with continuous forward velocity", () => {
  assert.equal(typeof camera.sampleCamera, "function", "camera sampler must exist")
  for (const variant of ["desktop", "portrait"]) {
    let prior
    for (let t = 0; t <= 56; t += 1 / 30) {
      const a = camera.sampleCamera(t, variant)
      assert.deepEqual(camera.sampleCamera(t, variant), a)
      assert.ok(a.position.every(Number.isFinite))
      assert.ok(a.target[2] < a.position[2])
      if (prior) {
        assert.ok(a.position[2] <= prior.position[2])
        assert.ok(Math.hypot(...a.position.map((v, i) => v - prior.position[i])) < 0.1)
      }
      prior = a
    }
  }
})
test("sampling clamps at the camera endpoints", () => {
  assert.equal(typeof camera.sampleCamera, "function")
  assert.deepEqual(camera.sampleCamera(-10, "desktop"), camera.sampleCamera(0, "desktop"))
  assert.deepEqual(camera.sampleCamera(100, "portrait"), camera.sampleCamera(56, "portrait"))
})
test("changing angles begin diagonally and resolve to a frontal report", () => {
  const opening = camera.sampleCamera(0, "desktop")
  const finish = camera.sampleCamera(56, "desktop")
  assert.ok(opening.position[0] > 4, "opening needs a diagonal approach")
  assert.ok(Math.abs(finish.position[0]) < 0.75, "report settles in front of the folio")
  const angles = Array.from({ length: 57 }, (_, time) => {
    const pose = camera.sampleCamera(time, "desktop")
    return (Math.atan2(pose.position[0], 9) * 180) / Math.PI
  })
  assert.ok(Math.max(...angles) - Math.min(...angles) > 12)
  for (let time = 0; time <= 56; time++) {
    const portrait = camera.sampleCamera(time, "portrait")
    assert.ok(Math.abs(portrait.position[0]) <= 3, "portrait arcs keep the folio inside its frame")
  }
})
test("camera sweeps across the folio and pushes closer through the evidence chapters", () => {
  const samples = Array.from({ length: 57 }, (_, time) => camera.sampleCamera(time, "desktop"))
  assert.ok(Math.max(...samples.map((pose) => pose.position[0])) > 5)
  assert.ok(Math.min(...samples.map((pose) => pose.position[0])) < -4)
  assert.ok(samples[0].position[2] - 1 > 12, "opening establishes the wider workspace")
  assert.ok(samples[28].position[2] - (1 - 84 * 0.5) < 8, "evidence gets a clear dolly push")
})
test("larger arcs preserve the copy-safe folio framing in both formats", () => {
  for (const variant of ["desktop", "portrait"]) {
    for (let time = 0; time <= 56; time++) {
      const pose = camera.sampleCamera(time, variant)
      const lens = new PerspectiveCamera(pose.fov, variant === "desktop" ? 16 / 9 : 9 / 16)
      lens.position.set(...pose.position)
      lens.lookAt(...pose.target)
      lens.updateMatrixWorld()
      const center = new Vector3(0, 2.25, 1 - (84 * time) / 56).project(lens)
      assert.ok(center.x > (variant === "desktop" ? 0.15 : -0.25) && center.x < 0.85)
      assert.ok(center.y > (variant === "portrait" ? 0.15 : -0.2) && center.y < 0.8)
    }
  }
})
test("the architectural passage leaves the moving evidence folio unobstructed", () => {
  const world = createWorld()
  try {
    const folio = world.scene.getObjectByName("evidence-folio")
    for (const variant of ["desktop", "portrait"]) {
      for (let time = 0; time <= 56; time += 0.5) {
        world.sample(time)
        world.scene.updateMatrixWorld(true)
        const origin = new Vector3(...camera.sampleCamera(time, variant).position)
        const ray = new Raycaster(origin, folio.position.clone().sub(origin).normalize())
        const visible = ray
          .intersectObjects(world.scene.children, true)
          .find(({ object }) => !object.material.transparent)
        assert.equal(visible?.object.parent.name, "evidence-folio", `${variant} at ${time}s`)
      }
    }
  } finally {
    world.dispose()
  }
})
