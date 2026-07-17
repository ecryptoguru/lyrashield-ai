import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const masters = resolve(root, "renders/masters")
const frameSelector =
  "select='eq(n,0)+eq(n,180)+eq(n,360)+eq(n,540)+eq(n,720)+eq(n,900)+eq(n,1080)+eq(n,1259)'"

function frameHashes(file) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      file,
      "-vf",
      frameSelector,
      "-vsync",
      "0",
      "-f",
      "framemd5",
      "-",
    ],
    {
      cwd: root,
      encoding: "utf8",
    }
  )
  if (result.status !== 0) throw new Error(result.stderr || `Could not hash ${file}`)
  return result.stdout
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(",").at(-1)?.trim())
}

for (const variant of ["desktop", "portrait"]) {
  const source = resolve(masters, `assurance-world-${variant}-check-a.mp4`)
  const repeat = resolve(masters, `assurance-world-${variant}-check-b.mp4`)
  const sourceHashes = frameHashes(source)
  const repeatHashes = frameHashes(repeat)
  if (
    sourceHashes.length !== 8 ||
    sourceHashes.some((hash, index) => hash !== repeatHashes[index])
  ) {
    throw new Error(`${variant} source-frame hashes changed across deterministic renders`)
  }
}

console.log("Deterministic source-frame hashes match across two desktop and portrait renders.")
