import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"

const root = resolve(import.meta.dirname, "..")
const output = resolve(root, "renders/web")
const temp = resolve(root, "renders/.verify")
const chapters = ["gateway", "target", "scan", "evidence-state", "fix-proposal", "retest", "report"]
const limits = { desktop: 3.5 * 1024 * 1024, portrait: 2.5 * 1024 * 1024 }
const dimensions = { desktop: [1600, 900], portrait: [720, 1280] }

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`)
  return `${result.stdout}${result.stderr}`
}

function probe(file) {
  return JSON.parse(
    capture("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file])
  )
}

function assertFaststart(file) {
  const bytes = readFileSync(file)
  const moov = bytes.indexOf(Buffer.from("moov"))
  const mdat = bytes.indexOf(Buffer.from("mdat"))
  if (moov < 0 || mdat < 0 || moov > mdat) throw new Error(`${file} is missing faststart metadata`)
}

function assertShortGop(file) {
  const frames = JSON.parse(
    capture("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_frames",
      "-show_entries",
      "frame=key_frame",
      "-of",
      "json",
      file,
    ])
  ).frames
  const keyframes = frames.flatMap((frame, index) => (frame.key_frame === 1 ? [index] : []))
  if (
    keyframes[0] !== 0 ||
    keyframes.some((frame, index) => index > 0 && frame - keyframes[index - 1] > 6)
  ) {
    throw new Error(`${file} does not keep the six-frame GOP contract`)
  }
}

for (const variant of ["desktop", "portrait"]) {
  for (const chapter of chapters) {
    for (const format of ["mp4", "webm"]) {
      const file = resolve(output, variant, `${chapter}.${format}`)
      if (!existsSync(file)) throw new Error(`Missing ${file}`)
      if (statSync(file).size > limits[variant])
        throw new Error(`${file} exceeds the ${variant} budget`)
      const details = probe(file)
      const video = details.streams.find((stream) => stream.codec_type === "video")
      if (
        !video ||
        Number(video.r_frame_rate.split("/")[0]) / Number(video.r_frame_rate.split("/")[1]) !== 30
      )
        throw new Error(`${file} is not 30 fps`)
      const [width, height] = dimensions[variant]
      if (video.width !== width || video.height !== height)
        throw new Error(`${file} has unexpected dimensions`)
      if (video.pix_fmt !== "yuv420p") throw new Error(`${file} must use yuv420p`)
      if (format === "mp4" && video.codec_name !== "h264") throw new Error(`${file} must use H.264`)
      if (format === "webm" && video.codec_name !== "vp9") throw new Error(`${file} must use VP9`)
      if (Number(details.format.duration) < 5.95 || Number(details.format.duration) > 6.12)
        throw new Error(`${file} has unexpected duration`)
      if (details.streams.some((stream) => stream.codec_type === "audio"))
        throw new Error(`${file} unexpectedly contains audio`)
      if (format === "mp4") assertFaststart(file)
      assertShortGop(file)
    }
  }
}

for (const [variant, width, height] of [
  ["desktop", 1920, 1080],
  ["portrait", 1080, 1920],
]) {
  const master = resolve(root, "renders/masters", `assurance-world-${variant}.mp4`)
  const details = probe(master)
  const video = details.streams.find((stream) => stream.codec_type === "video")
  if (
    !video ||
    video.width !== width ||
    video.height !== height ||
    Number(details.format.duration) !== 42
  ) {
    throw new Error(`${master} does not match the 42-second master contract`)
  }
  if (details.streams.some((stream) => stream.codec_type === "audio"))
    throw new Error(`${master} unexpectedly contains audio`)
}

for (const [variant, width, height] of [
  ["desktop", 1920, 1080],
  ["portrait", 1080, 1920],
]) {
  const master = resolve(root, "renders/masters", `assurance-world-${variant}-web.mp4`)
  const details = probe(master)
  const video = details.streams.find((stream) => stream.codec_type === "video")
  if (
    !video ||
    video.width !== width ||
    video.height !== height ||
    Number(details.format.duration) !== 42
  ) {
    throw new Error(`${master} does not match the geometry-only web master contract`)
  }
  if (details.streams.some((stream) => stream.codec_type === "audio"))
    throw new Error(`${master} unexpectedly contains audio`)
}

for (const [name, duration, width, height] of [
  ["lyrashield-launch-30s-landscape.mp4", 30, 1920, 1080],
  ["lyrashield-launch-15s-portrait.mp4", 15, 1080, 1920],
]) {
  const file = resolve(output, "launch", name)
  const details = probe(file)
  const video = details.streams.find((stream) => stream.codec_type === "video")
  if (
    !video ||
    video.width !== width ||
    video.height !== height ||
    Math.abs(Number(details.format.duration) - duration) > 0.04
  ) {
    throw new Error(`${file} does not match its launch-edit contract`)
  }
  if (details.streams.some((stream) => stream.codec_type === "audio"))
    throw new Error(`${file} unexpectedly contains audio`)
  assertFaststart(file)
}

for (const variant of ["desktop", "portrait"]) {
  for (const chapter of chapters) {
    for (const format of ["avif", "webp", "jpg"]) {
      const poster = resolve(output, "posters", `${chapter}-${variant}.${format}`)
      if (!existsSync(poster) || statSync(poster).size === 0) throw new Error(`Missing ${poster}`)
    }
  }
}

rmSync(temp, { recursive: true, force: true })
mkdirSync(temp, { recursive: true })

for (const variant of ["desktop", "portrait"]) {
  for (let index = 0; index < chapters.length - 1; index += 1) {
    const previous = resolve(output, variant, `${chapters[index]}.mp4`)
    const next = resolve(output, variant, `${chapters[index + 1]}.mp4`)
    const previousFrame = resolve(temp, `${variant}-${index}-previous.png`)
    const nextFrame = resolve(temp, `${variant}-${index}-next.png`)
    capture("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      previous,
      "-vf",
      "select=eq(n\\,180)",
      "-vsync",
      "0",
      "-frames:v",
      "1",
      previousFrame,
    ])
    capture("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      next,
      "-frames:v",
      "1",
      nextFrame,
    ])
    if (!readFileSync(previousFrame).equals(readFileSync(nextFrame)))
      throw new Error(`${variant} seam ${index} boundary frames are not byte-identical`)
    const result = capture("ffmpeg", [
      "-hide_banner",
      "-i",
      previousFrame,
      "-i",
      nextFrame,
      "-lavfi",
      "ssim",
      "-f",
      "null",
      "-",
    ])
    const score = Number(result.match(/All:([0-9.]+)/)?.[1])
    if (!Number.isFinite(score) || score < 0.995)
      throw new Error(`${variant} seam ${index} SSIM ${score || "missing"} is below 0.995`)
  }
}

rmSync(temp, { recursive: true, force: true })
console.log(
  "Motion media verified: masters, launch edits, codecs, dimensions, GOPs, faststart, budgets, posters, silence, and seams pass."
)
