import { mkdirSync, rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const root = resolve(import.meta.dirname, "..")
const masters = resolve(root, "renders/masters")
const output = resolve(root, "renders/web")
const encoded = resolve(output, ".encoded")
const chapters = ["gateway", "target", "scan", "evidence-state", "fix-proposal", "retest", "report"]

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" })
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`)
}

function encodeMaster(input, target, scale, format) {
  mkdirSync(dirname(target), { recursive: true })
  const common = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    input,
    "-vf",
    `scale=${scale}:force_original_aspect_ratio=decrease,fps=30`,
    "-an",
  ]

  if (format === "mp4") {
    run("ffmpeg", [
      ...common,
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "25",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "6",
      "-keyint_min",
      "6",
      "-sc_threshold",
      "0",
      "-movflags",
      "+faststart",
      target,
    ])
    return
  }

  run("ffmpeg", [
    ...common,
    "-c:v",
    "libvpx-vp9",
    "-crf",
    "34",
    "-b:v",
    "0",
    "-g",
    "6",
    "-row-mt",
    "1",
    target,
  ])
}

function splitClip(input, target, start, duration, format) {
  mkdirSync(dirname(target), { recursive: true })
  const faststart = format === "mp4" ? ["-movflags", "+faststart"] : []
  run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    start.toFixed(3),
    "-i",
    input,
    "-t",
    duration.toFixed(3),
    "-map",
    "0:v:0",
    "-an",
    "-c",
    "copy",
    ...faststart,
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
    "-i",
    input,
    "-ss",
    time.toFixed(3),
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

function deriveVariant(name, input, scale) {
  const encodedMp4 = resolve(encoded, `${name}.mp4`)
  const encodedWebm = resolve(encoded, `${name}.webm`)
  encodeMaster(input, encodedMp4, scale, "mp4")
  encodeMaster(input, encodedWebm, scale, "webm")

  chapters.forEach((chapter, index) => {
    const start = index * 6
    const duration = index === chapters.length - 1 ? 6 : 6 + 1 / 30
    const base = resolve(output, name, chapter)
    splitClip(encodedMp4, `${base}.mp4`, start, duration, "mp4")
    splitClip(encodedWebm, `${base}.webm`, start, duration, "webm")
    makePoster(input, resolve(output, "posters", `${chapter}-${name}`), start + 3, scale)
  })
}

rmSync(output, { recursive: true, force: true })
deriveVariant("desktop", resolve(masters, "assurance-world-desktop-web.mp4"), "1600:900")
deriveVariant("portrait", resolve(masters, "assurance-world-portrait-web.mp4"), "720:1280")
rmSync(encoded, { recursive: true, force: true })

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
