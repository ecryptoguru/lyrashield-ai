import { gsap } from "gsap"
import * as THREE from "three"
import { createWorld } from "./world"
import { sampleCamera } from "./camera"
import "./style.css"

const canvas = document.querySelector<HTMLCanvasElement>("#world")
if (!canvas) throw new Error("World canvas is missing")
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
renderer.setSize(__COMPOSITION_WIDTH__, __COMPOSITION_HEIGHT__, false)
renderer.setPixelRatio(1)
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.2
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFShadowMap
const world = createWorld()
const camera = new THREE.PerspectiveCamera(
  42,
  __COMPOSITION_WIDTH__ / __COMPOSITION_HEIGHT__,
  0.1,
  130
)
const variant = __COMPOSITION_HEIGHT__ > __COMPOSITION_WIDTH__ ? "portrait" : "desktop"
const state = { time: 0 }
function renderWorld() {
  const pose = sampleCamera(state.time, variant)
  camera.position.set(...pose.position)
  camera.lookAt(new THREE.Vector3(...pose.target))
  camera.fov = pose.fov
  camera.updateProjectionMatrix()
  world.sample(state.time)
  renderer.render(world.scene, camera)
}
const timeline = gsap.timeline({ paused: true })
timeline.to(
  state,
  {
    time: __CAPTURE_DURATION__,
    duration: __CAPTURE_DURATION__,
    ease: "none",
    onUpdate: renderWorld,
  },
  0
)
window.__timelines = window.__timelines || {}
window.__timelines[__COMPOSITION_ID__] = timeline
renderWorld()
window.addEventListener(
  "pagehide",
  () => {
    world.dispose()
    renderer.dispose()
  },
  { once: true }
)
