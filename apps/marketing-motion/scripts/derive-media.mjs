import { mkdirSync, rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import {
  MOTION_CHAPTERS,
  MOTION_CHAPTER_DURATION,
  MOTION_DURATION,
  MOTION_FPS,
  MOTION_GOP,
  MOTION_VARIANTS,
  motionPosterRelativePath,
  motionTrackRelativePath,
} from "./motion-media-contract.mjs"

const root = resolve(import.meta.dirname, "..")
const masters = resolve(root, "renders/masters")
const output = resolve(root, "renders/web")

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" })
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`)
}

function encodeTrack(input, target, scale) {
  mkdirSync(dirname(target), { recursive: true })
  run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    input,
    "-vf",
    `scale=${scale}:force_original_aspect_ratio=decrease,fps=${MOTION_FPS}`,
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "26",
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(MOTION_GOP),
    "-keyint_min",
    String(MOTION_GOP),
    "-sc_threshold",
    "0",
    "-movflags",
    "+faststart",
    target,
  ])
}

function makePoster(input, targetBase, time, scale) {
  const png = `${targetBase}.png`
  mkdirSync(dirname(targetBase), { recursive: true })
  run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    time.toFixed(3),
    "-i",
    input,
    "-frames:v",
    "1",
    "-vf",
    `scale=${scale}:force_original_aspect_ratio=decrease`,
    png,
  ])
  run("cwebp", ["-quiet", "-q", "76", png, "-o", `${targetBase}.webp`])
  run("sips", ["-s", "format", "avif", png, "--out", `${targetBase}.avif`])
  run("sips", [
    "-s",
    "format",
    "jpeg",
    "-s",
    "formatOptions",
    "76",
    png,
    "--out",
    `${targetBase}.jpg`,
  ])
  rmSync(png)
}

rmSync(output, { recursive: true, force: true })

for (const [variant, contract] of Object.entries(MOTION_VARIANTS)) {
  const input = resolve(masters, contract.master)
  const target = resolve(output, motionTrackRelativePath(variant))
  encodeTrack(input, target, contract.scale)

  MOTION_CHAPTERS.forEach((chapter, index) => {
    const poster = resolve(output, motionPosterRelativePath(chapter, variant, "webp"))
    makePoster(
      target,
      poster.slice(0, -".webp".length),
      index * MOTION_CHAPTER_DURATION + MOTION_CHAPTER_DURATION / 2,
      contract.scale
    )
  })
}

mkdirSync(resolve(output, "launch"), { recursive: true })
run("ffmpeg", [
  "-y",
  "-hide_banner",
  "-loglevel",
  "error",
  "-i",
  resolve(masters, "assurance-world-desktop.mp4"),
  "-vf",
  "setpts=PTS/1.4,fps=30",
  "-t",
  "30",
  "-an",
  "-c:v",
  "libx264",
  "-preset",
  "slow",
  "-crf",
  "22",
  "-pix_fmt",
  "yuv420p",
  "-movflags",
  "+faststart",
  resolve(output, "launch/lyrashield-launch-30s-landscape.mp4"),
])
run("ffmpeg", [
  "-y",
  "-hide_banner",
  "-loglevel",
  "error",
  "-i",
  resolve(masters, "assurance-world-portrait.mp4"),
  "-vf",
  "setpts=PTS/2.8,fps=30",
  "-t",
  "15",
  "-an",
  "-c:v",
  "libx264",
  "-preset",
  "slow",
  "-crf",
  "22",
  "-pix_fmt",
  "yuv420p",
  "-movflags",
  "+faststart",
  resolve(output, "launch/lyrashield-launch-15s-portrait.mp4"),
])

console.log(`Derived ${MOTION_DURATION}-second continuous Motion V2 tracks and chapter posters.`)
