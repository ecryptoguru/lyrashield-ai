import { gsap } from "gsap"
import * as THREE from "three"
import "./style.css"

const DURATION = 42
const CHAPTER_LENGTH = 6
const chapterIds = [
  "gateway",
  "target",
  "scan",
  "evidence",
  "proposal",
  "retest",
  "report",
] as const

function seededRandom(seed: number) {
  // ponytail: one deterministic generator is enough; replace only if visual distributions need independent streams.
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const root = document.querySelector<HTMLElement>("#root")
const canvas = document.querySelector<HTMLCanvasElement>("#world")
const focusTransition = document.querySelector<HTMLElement>("#focus-transition")

if (!root || !canvas || !focusTransition)
  throw new Error("Assurance world composition is incomplete")
root.classList.toggle("copy-hidden", import.meta.env.VITE_SHOW_COPY === "false")

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: "high-performance",
})
renderer.setSize(__COMPOSITION_WIDTH__, __COMPOSITION_HEIGHT__, false)
renderer.setPixelRatio(1)
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.08

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x08111c)
scene.fog = new THREE.FogExp2(0x08111c, 0.026)

const camera = new THREE.PerspectiveCamera(
  42,
  __COMPOSITION_WIDTH__ / __COMPOSITION_HEIGHT__,
  0.1,
  180
)
camera.position.set(8, 4, 11)

const textureLoader = new THREE.TextureLoader()
const textureUrls = {
  atmosphere: new URL("../public/assets/textures/atmosphere.webp", import.meta.url).href,
  graphite: new URL("../public/assets/textures/graphite.webp", import.meta.url).href,
  laminate: new URL("../public/assets/textures/laminate.webp", import.meta.url).href,
  signalHaze: new URL("../public/assets/textures/signal-haze.webp", import.meta.url).href,
} as const

const graphite = new THREE.MeshStandardMaterial({
  color: 0x172838,
  metalness: 0.72,
  roughness: 0.5,
})
const graphiteDark = new THREE.MeshStandardMaterial({
  color: 0x0e1a28,
  metalness: 0.58,
  roughness: 0.62,
})
const cyan = new THREE.MeshStandardMaterial({
  color: 0x54d6df,
  emissive: 0x2b8591,
  emissiveIntensity: 2.3,
  metalness: 0.22,
  roughness: 0.2,
})
const proof = new THREE.MeshStandardMaterial({
  color: 0x5cdb95,
  emissive: 0x216f4a,
  emissiveIntensity: 1.6,
  transparent: true,
  opacity: 0.84,
})
const caution = new THREE.MeshStandardMaterial({
  color: 0xf5b84b,
  emissive: 0x8d5f19,
  emissiveIntensity: 1.6,
  transparent: true,
  opacity: 0.84,
})
const failure = new THREE.MeshStandardMaterial({
  color: 0xff7168,
  emissive: 0x8b2e2a,
  emissiveIntensity: 1.5,
  transparent: true,
  opacity: 0.8,
})
const glass = new THREE.MeshPhysicalMaterial({
  color: 0x17364a,
  emissive: 0x123d4a,
  emissiveIntensity: 0.75,
  transparent: true,
  opacity: 0.44,
  roughness: 0.18,
  metalness: 0.12,
  transmission: 0.2,
})

textureLoader.load(textureUrls.atmosphere, (texture) => {
  texture.colorSpace = THREE.SRGBColorSpace
  scene.background = texture
})

textureLoader.load(textureUrls.graphite, (texture) => {
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(2, 2)
  graphite.map = texture
  graphite.needsUpdate = true
})

textureLoader.load(textureUrls.laminate, (texture) => {
  texture.colorSpace = THREE.SRGBColorSpace
  glass.map = texture
  glass.needsUpdate = true
})

const haze = new THREE.Mesh(
  new THREE.PlaneGeometry(36, 76),
  new THREE.MeshBasicMaterial({
    color: 0x54d6df,
    transparent: true,
    opacity: 0.1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
)
haze.position.set(0, 5, -34)
scene.add(haze)
textureLoader.load(textureUrls.signalHaze, (texture) => {
  texture.colorSpace = THREE.SRGBColorSpace
  const material = haze.material as THREE.MeshBasicMaterial
  material.map = texture
  material.needsUpdate = true
})

const ambient = new THREE.HemisphereLight(0x91dce5, 0x08111c, 1.45)
scene.add(ambient)

const keyLight = new THREE.DirectionalLight(0xb6f8ff, 3.8)
keyLight.position.set(5, 12, 8)
scene.add(keyLight)

const rimLight = new THREE.PointLight(0x54d6df, 52, 42, 1.4)
rimLight.position.set(-6, 4, -24)
scene.add(rimLight)

const floor = new THREE.Mesh(new THREE.PlaneGeometry(42, 92), graphiteDark)
floor.rotation.x = -Math.PI / 2
floor.position.set(0, -2.4, -25)
scene.add(floor)

const floorLines = new THREE.GridHelper(92, 46, 0x1b5362, 0x122a38)
floorLines.position.set(0, -2.36, -25)
floorLines.material.transparent = true
floorLines.material.opacity = 0.2
scene.add(floorLines)

const box = (
  group: THREE.Group,
  size: [number, number, number],
  position: [number, number, number],
  material = graphite
) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material)
  mesh.position.set(...position)
  group.add(mesh)
  return mesh
}

const framedPlane = (group: THREE.Group, x: number, color: number, material: THREE.Material) => {
  const plane = new THREE.Mesh(new THREE.BoxGeometry(2.25, 3.5, 0.12), material)
  plane.position.set(x, 0.4, 0)
  group.add(plane)
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(plane.geometry),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 })
  )
  edges.position.copy(plane.position)
  group.add(edges)
}

const stations: THREE.Group[] = []

const gateway = new THREE.Group()
gateway.position.z = 0
box(gateway, [1.35, 7.8, 1.7], [-3.1, 1.45, 0])
box(gateway, [1.35, 7.8, 1.7], [3.1, 1.45, 0])
box(gateway, [7.5, 1.4, 1.7], [0, 4.7, 0])
box(gateway, [4.5, 0.17, 0.5], [0, -1.85, 0], cyan)
stations.push(gateway)
scene.add(gateway)

const target = new THREE.Group()
target.position.set(0, 0, -9)
box(target, [4.1, 3.2, 3.1], [0, -0.65, 0])
const targetCore = new THREE.Mesh(new THREE.IcosahedronGeometry(1.05, 1), cyan)
targetCore.position.y = 1.4
target.add(targetCore)
stations.push(target)
scene.add(target)

const scan = new THREE.Group()
scan.position.set(0, 0, -18)
for (let index = 0; index < 4; index += 1) {
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(2.2 + index * 0.55, 0.08, 12, 80),
    index % 2 ? glass : cyan
  )
  ring.rotation.y = Math.PI / 2
  ring.position.z = index * 0.55 - 0.8
  scan.add(ring)
}
box(scan, [0.18, 4.8, 0.18], [-3.4, 0.2, 0], cyan)
box(scan, [0.18, 4.8, 0.18], [3.4, 0.2, 0], cyan)
stations.push(scan)
scene.add(scan)

const evidence = new THREE.Group()
evidence.position.set(0, 0, -27)
framedPlane(evidence, -3.8, 0x54d6df, glass)
framedPlane(evidence, -1.25, 0x5cdb95, proof)
framedPlane(evidence, 1.25, 0xf5b84b, caution)
framedPlane(evidence, 3.8, 0xff7168, failure)
stations.push(evidence)
scene.add(evidence)

const proposal = new THREE.Group()
proposal.position.set(0, 0, -36)
for (let index = 0; index < 3; index += 1) {
  const patch = new THREE.Mesh(
    new THREE.BoxGeometry(4.7, 3.1, 0.16),
    index === 1 ? glass : graphite
  )
  patch.position.set((index - 1) * 0.65, 0.2 + index * 0.38, -index * 0.5)
  patch.rotation.y = (index - 1) * 0.08
  proposal.add(patch)
}
const shackle = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.18, 18, 48, Math.PI), caution)
shackle.rotation.z = Math.PI
shackle.position.set(0, 2.35, 0.35)
proposal.add(shackle)
box(proposal, [1.9, 1.5, 0.55], [0, 1.3, 0.35], caution)
stations.push(proposal)
scene.add(proposal)

const retest = new THREE.Group()
retest.position.set(0, 0, -45)
for (let index = 0; index < 3; index += 1) {
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(2.2 + index * 0.62, 0.15, 20, 88),
    index === 1 ? proof : cyan
  )
  ring.rotation.x = Math.PI / 2
  ring.rotation.y = index * 0.22
  retest.add(ring)
}
const retestCore = new THREE.Mesh(new THREE.DodecahedronGeometry(1.15), glass)
retestCore.position.y = 0.2
retest.add(retestCore)
stations.push(retest)
scene.add(retest)

const report = new THREE.Group()
report.position.set(0, 0, -56)
box(report, [7.2, 5.8, 0.45], [0, 0.7, 0])
box(report, [5.8, 0.14, 0.18], [0, 2.25, 0.32], cyan)
box(report, [2.5, 0.12, 0.16], [-1.65, 1.45, 0.34], proof)
box(report, [1.6, 0.12, 0.16], [2.1, 1.45, 0.34], caution)
for (let row = 0; row < 4; row += 1) {
  box(
    report,
    [5.6 - row * 0.45, 0.09, 0.15],
    [-0.2 + row * 0.2, 0.55 - row * 0.58, 0.35],
    row === 3 ? failure : glass
  )
}
stations.push(report)
scene.add(report)

const signalCurve = new THREE.CatmullRomCurve3([
  new THREE.Vector3(0, 0.1, 4),
  new THREE.Vector3(-0.8, 0.35, 0),
  new THREE.Vector3(0.8, 0.2, -9),
  new THREE.Vector3(-0.7, 0.45, -18),
  new THREE.Vector3(0, 0.2, -27),
  new THREE.Vector3(0.7, 0.5, -36),
  new THREE.Vector3(-0.6, 0.2, -45),
  new THREE.Vector3(0, 0.5, -56),
])
const signal = new THREE.Mesh(new THREE.TubeGeometry(signalCurve, 220, 0.075, 10, false), cyan)
scene.add(signal)

const random = seededRandom(719)
const particlePositions = new Float32Array(850 * 3)
for (let index = 0; index < 850; index += 1) {
  particlePositions[index * 3] = (random() - 0.5) * 28
  particlePositions[index * 3 + 1] = random() * 13 - 3
  particlePositions[index * 3 + 2] = random() * -72 + 9
}
const particleGeometry = new THREE.BufferGeometry()
particleGeometry.setAttribute("position", new THREE.BufferAttribute(particlePositions, 3))
const particles = new THREE.Points(
  particleGeometry,
  new THREE.PointsMaterial({
    color: 0x54d6df,
    size: 0.035,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
  })
)
scene.add(particles)

const artifacts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), graphite, 42)
const matrix = new THREE.Matrix4()
for (let index = 0; index < 42; index += 1) {
  matrix.makeTranslation((random() - 0.5) * 16, random() * 6 - 1, random() * -64 + 3)
  artifacts.setMatrixAt(index, matrix)
}
scene.add(artifacts)

const cameraPath = new THREE.CatmullRomCurve3([
  new THREE.Vector3(8.5, 4.2, 11),
  new THREE.Vector3(6.8, 3.4, 2.5),
  new THREE.Vector3(-6.5, 3.2, -6),
  new THREE.Vector3(5.8, 3.6, -15),
  new THREE.Vector3(-6.3, 3.25, -24),
  new THREE.Vector3(6.1, 3.7, -33),
  new THREE.Vector3(-5.8, 3.4, -42),
  new THREE.Vector3(5, 4.1, -52),
])
const targetPath = new THREE.CatmullRomCurve3(
  stations.map((station) => new THREE.Vector3(0, 0.55, station.position.z))
)
const cameraState = { progress: 0 }

function renderWorld() {
  const progress = THREE.MathUtils.clamp(cameraState.progress, 0, 0.9999)
  camera.position.copy(cameraPath.getPointAt(progress))
  const lookAt = targetPath.getPointAt(progress)
  camera.lookAt(lookAt)
  renderer.render(scene, camera)
}

window.__timelines = window.__timelines || {}
const timeline = gsap.timeline({ paused: true, defaults: { duration: 0.55, ease: "power2.out" } })

timeline.to(cameraState, { progress: 1, duration: DURATION, ease: "none" }, 0)
timeline.to(particles.rotation, { y: 0.34, duration: DURATION, ease: "none" }, 0)
timeline.to(
  signal.material,
  { emissiveIntensity: 3.1, duration: DURATION / 2, repeat: 1, yoyo: true, ease: "sine.inOut" },
  0
)

chapterIds.forEach((chapter, index) => {
  const start = index * CHAPTER_LENGTH
  const selector = `#scene-${chapter}`
  const stage = stations[index]

  timeline.from(
    stage.scale,
    { x: 0.82, y: 0.82, z: 0.82, duration: 0.85, ease: "power3.out" },
    start + 0.15
  )
  timeline.from(
    stage.position,
    { y: stage.position.y - 0.7, duration: 0.7, ease: "back.out(1.2)" },
    start + 0.2
  )
  timeline.from(
    `${selector} .scene-index`,
    { opacity: 0, y: 28, duration: 0.42, ease: "power2.out" },
    start + 0.18
  )
  timeline.from(
    `${selector} h1, ${selector} h2`,
    { opacity: 0, y: 56, scale: 0.97, duration: 0.72, ease: "power4.out" },
    start + 0.32
  )

  const body = document.querySelector(`${selector} p:not(.scene-index), ${selector} .state-list`)
  if (body)
    timeline.from(
      body,
      { opacity: 0, x: index % 2 === 0 ? -36 : 36, duration: 0.58, ease: "expo.out" },
      start + 0.58
    )

  const accent = document.querySelector(`${selector} .scene-rule, ${selector} .report-status`)
  if (accent)
    timeline.from(
      accent,
      {
        opacity: 0,
        scaleX: 0.2,
        transformOrigin: index % 2 === 0 ? "left center" : "right center",
        duration: 0.5,
        ease: "sine.out",
      },
      start + 0.82
    )
})

timeline.from(
  "#scene-evidence .state-list li",
  { x: 24, stagger: 0.1, duration: 0.38, ease: "power3.out" },
  18.78
)

for (let boundary = CHAPTER_LENGTH; boundary < DURATION; boundary += CHAPTER_LENGTH) {
  timeline.fromTo(
    focusTransition,
    { opacity: 0, scale: 1.035 },
    { opacity: 0.72, scale: 1, duration: 0.28, repeat: 1, yoyo: true, ease: "sine.inOut" },
    boundary - 0.28
  )
}

timeline.to(
  "#scene-report .scene-content",
  { opacity: 0, y: -26, duration: 0.65, ease: "power2.in" },
  41.2
)
timeline.eventCallback("onUpdate", renderWorld)
window.__timelines[__COMPOSITION_ID__] = timeline

renderWorld()
