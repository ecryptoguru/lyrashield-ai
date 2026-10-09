import * as THREE from "three"
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js"

type Materials = ReturnType<typeof createMaterials>
type MaterialName = keyof Materials
type WorldBuild = {
  scene: THREE.Scene
  materials: Materials
  geometries: Set<THREE.BufferGeometry>
}

function createMaterials() {
  return {
    structure: new THREE.MeshStandardMaterial({
      color: 0x72899b,
      metalness: 0.12,
      roughness: 0.62,
    }),
    dark: new THREE.MeshStandardMaterial({ color: 0x344f68, metalness: 0.08, roughness: 0.7 }),
    edge: new THREE.MeshStandardMaterial({ color: 0x9bb1c0, metalness: 0.28, roughness: 0.4 }),
    cyan: new THREE.MeshStandardMaterial({
      color: 0x00bae6,
      emissive: 0x008eae,
      emissiveIntensity: 0.55,
      roughness: 0.35,
    }),
    amber: new THREE.MeshStandardMaterial({
      color: 0xf3b95f,
      emissive: 0x9b6023,
      emissiveIntensity: 0.55,
      roughness: 0.45,
    }),
    paper: new THREE.MeshStandardMaterial({ color: 0xdbe6ed, metalness: 0.08, roughness: 0.5 }),
    glass: new THREE.MeshStandardMaterial({
      color: 0x29758b,
      transparent: true,
      opacity: 0.3,
      metalness: 0.25,
      roughness: 0.2,
      depthWrite: false,
    }),
  }
}

function box(
  world: WorldBuild,
  parent: THREE.Object3D,
  size: readonly number[],
  position: readonly number[],
  material: MaterialName = "structure"
) {
  const geometry =
    size[0]! > 0.9 && size[1]! > 0.7
      ? new RoundedBoxGeometry(size[0]!, size[1]!, size[2]!, 2, Math.min(0.055, size[2]! / 4))
      : new THREE.BoxGeometry(size[0], size[1], size[2])
  world.geometries.add(geometry)
  const mesh = new THREE.Mesh(geometry, world.materials[material])
  mesh.position.set(position[0]!, position[1]!, position[2]!)
  mesh.castShadow = material !== "glass"
  mesh.receiveShadow = true
  parent.add(mesh)
  return mesh
}

function route(
  world: WorldBuild,
  parent: THREE.Object3D,
  points: THREE.Vector3[],
  material: MaterialName = "cyan",
  radius = 0.025
) {
  const geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 32, radius, 6, false)
  world.geometries.add(geometry)
  const mesh = new THREE.Mesh(geometry, world.materials[material])
  parent.add(mesh)
  return mesh
}

function addLighting(world: WorldBuild) {
  world.scene.add(new THREE.HemisphereLight(0xeaf4ff, 0x607991, 3.0))
  const key = new THREE.DirectionalLight(0xfff4e5, 2.0)
  key.position.set(5, 12, 8)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.camera.left = -12
  key.shadow.camera.right = 12
  key.shadow.camera.top = 10
  key.shadow.camera.bottom = -10
  key.shadow.bias = -0.001
  world.scene.add(key, key.target)

  const rim = new THREE.DirectionalLight(0x54c3d9, 0.9)
  rim.position.set(-6, 4, -20)
  world.scene.add(rim)
  const fill = new THREE.DirectionalLight(0xdcefff, 1.4)
  fill.position.set(-5, 8, 12)
  world.scene.add(fill)
  return key
}

function addArchitecture(world: WorldBuild) {
  const { scene } = world
  box(world, scene, [20, 0.45, 110], [0, -0.9, -38], "dark")
  // Paired machined ribs provide a grounded, continuous architectural axis.
  for (let i = 0; i < 19; i++) {
    const z = 8 - i * 5
    box(world, scene, [0.3, 8, 0.65], [-7, 3, z])
    box(world, scene, [0.3, 8, 0.65], [7, 3, z])
    box(world, scene, [14, 0.35, 0.65], [0, 7, z])
    box(world, scene, [0.08, 0.03, 4.3], [-4.4, -0.65, z - 2], "cyan")
    box(world, scene, [0.08, 0.03, 4.3], [4.4, -0.65, z - 2], "cyan")
  }
}

function addStationDetails(world: WorldBuild, station: THREE.Group, index: number) {
  if (index === 0) {
    box(world, station, [0.7, 7.05, 1.2], [-6, 2.975, -1])
    box(world, station, [0.7, 7.05, 1.2], [6, 2.975, -1])
    box(world, station, [12.7, 0.7, 1.2], [0, 6.5, -1])
    box(world, station, [11.1, 0.055, 0.08], [0, 6.1, -0.3], "cyan")
  } else if (index === 1) {
    for (const x of [-3.4, 3.4]) {
      box(world, station, [0.065, 3.4, 4], [x, 1.55, 0], "glass")
      box(world, station, [0.06, 0.05, 4], [x, 3.25, 0], "cyan")
    }
    for (let n = 0; n < 3; n++)
      box(world, station, [0.9, 0.1, 1.2], [-2.5 + n * 2.5, 0.5, -1], "paper")
  } else if (index === 2) {
    for (let n = 0; n < 4; n++) {
      const x = -3 + n * 2
      box(world, station, [0.7, 0.35, 1.8], [x, 0.6, -0.8])
      route(world, station, [
        new THREE.Vector3(x, 0.85, -0.8),
        new THREE.Vector3(x, 1.5, 0.7),
        new THREE.Vector3(0, 1.7, 1.5),
      ])
    }
  } else if (index === 3) {
    for (const x of [-5.8, 5.8]) {
      const frame = box(world, station, [1.4, 3.3, 0.16], [x, 2.1, -0.8], "edge")
      frame.rotation.y = x < 0 ? 0.18 : -0.18
      box(world, station, [1.1, 0.06, 0.08], [x, 3.2, -0.65], "amber")
    }
  } else if (index === 4) {
    box(world, station, [0.18, 4.4, 4.5], [2.8, 1.7, 0], "glass")
    for (let n = 0; n < 5; n++)
      box(world, station, [0.14, 0.08, 3.5], [2.9, 0.6 + n * 0.6, 0], "amber")
    box(world, station, [2.0, 0.2, 2.5], [-2.5, 0.5, -0.4], "paper")
  } else if (index === 5) {
    for (const x of [-2.5, 2.5]) {
      box(world, station, [2.2, 2.7, 0.1], [x, 2, -0.5], "glass")
      box(world, station, [1.8, 0.055, 0.12], [x, 3.2, -0.35], "cyan")
    }
    // The amber break represents missing proof; it never closes.
    route(
      world,
      station,
      [new THREE.Vector3(-2.5, 1, -0.3), new THREE.Vector3(-0.7, 1, 0.5)],
      "amber"
    )
    route(
      world,
      station,
      [new THREE.Vector3(0.7, 1, 0.5), new THREE.Vector3(2.5, 1, -0.3)],
      "amber"
    )
  } else {
    for (let n = 0; n < 3; n++)
      box(world, station, [3.3, 0.16, 3], [-2.5, 0.6 + n * 0.23, -0.8], "paper")
    box(world, station, [3.3, 0.055, 0.12], [-2.5, 1.35, 0.7], "amber")
  }
}

function addStations(world: WorldBuild) {
  // Each station adds a specific evidence relationship to the connected space.
  for (let i = 0; i < 7; i++) {
    const station = new THREE.Group()
    station.position.z = -i * 12
    world.scene.add(station)
    box(world, station, [8.5, 0.35, 6], [0, -0.48, 0], "edge")
    addStationDetails(world, station, i)
  }
}

function addEvidenceFolio(world: WorldBuild) {
  const record = new THREE.Group()
  record.name = "evidence-folio"
  world.scene.add(record)
  box(world, record, [2.4, 3.2, 0.18], [0, 0, 0], "edge")
  box(world, record, [2.18, 2.96, 0.09], [0, 0, 0.13], "dark")
  box(world, record, [0.055, 0.65, 0.08], [-0.9, 0.92, 0.21], "cyan")
  box(world, record, [1.35, 0.09, 0.07], [0.03, 1.15, 0.21], "paper")
  box(world, record, [0.95, 0.06, 0.07], [-0.16, 0.93, 0.21], "edge")
  const rows = Array.from({ length: 6 }, (_, i) => {
    const row = new THREE.Group()
    row.position.y = 0.45 - i * 0.31
    box(world, row, [0.11, 0.11, 0.07], [-0.88, 0, 0.21], i > 3 ? "amber" : "cyan")
    box(world, row, [1.45, 0.055, 0.06], [0.03, 0, 0.21], "edge")
    record.add(row)
    return row
  })
  const proposal = box(world, record, [2.12, 2.8, 0.07], [0.22, -0.08, -0.22], "glass")
  const limit = box(world, record, [1.8, 0.075, 0.08], [0, -1.24, 0.22], "amber")
  return { record, rows, proposal, limit }
}

/** Build-time geometry only. Factual content belongs to the page's HTML. */
export function createWorld() {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x344c64)
  scene.fog = new THREE.FogExp2(0x344c64, 0.018)
  const world: WorldBuild = {
    scene,
    materials: createMaterials(),
    geometries: new Set(),
  }
  const key = addLighting(world)
  addArchitecture(world)
  addStations(world)
  const { record, rows, proposal, limit } = addEvidenceFolio(world)

  function sample(time: number) {
    const progress = Math.max(0, Math.min(1, time / 56))
    record.position.set(0, 2.25, 1 - 84 * progress)
    record.rotation.set(0.02, -0.1 + 0.12 * Math.sin(progress * Math.PI * 2), 0)
    rows.forEach((row, i) => {
      row.scale.x = Math.min(1, Math.max(0.12, (time - i * 7) / 3))
    })
    proposal.position.x = 0.22 + Math.max(0, Math.min(1, (time - 32) / 4)) * 0.8
    limit.scale.x = 0.4 + Math.max(0, Math.min(1, (time - 40) / 4)) * 0.6
    key.position.z = 9 - 84 * progress
    key.target.position.set(0, 1, 1 - 84 * progress)
  }
  function dispose() {
    world.geometries.forEach((geometry) => geometry.dispose())
    Object.values(world.materials).forEach((material) => material.dispose())
    key.shadow.map?.dispose()
  }

  sample(0)
  return { scene, sample, dispose }
}
