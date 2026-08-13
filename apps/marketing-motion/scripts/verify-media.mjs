import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import {
  MOTION_CHAPTERS,
  MOTION_DURATION,
  MOTION_FPS,
  MOTION_GOP,
  MOTION_VARIANTS,
  motionPosterRelativePath,
  motionTrackRelativePath,
} from "./motion-media-contract.mjs"

const root = resolve(import.meta.dirname, "..")
const output = resolve(root, "renders/web")

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
    keyframes.some((frame, index) => index > 0 && frame - keyframes[index - 1] > MOTION_GOP)
  )
    throw new Error(`${file} exceeds the ${MOTION_GOP}-frame GOP contract`)
}

for (const [variant, contract] of Object.entries(MOTION_VARIANTS)) {
  const file = resolve(output, motionTrackRelativePath(variant))
  if (!existsSync(file)) throw new Error(`Missing ${file}`)
  if (statSync(file).size > contract.budgetBytes) throw new Error(`${file} exceeds its byte budget`)
  const details = probe(file)
  const video = details.streams.find((stream) => stream.codec_type === "video")
  const [rateNumerator, rateDenominator] = video?.r_frame_rate?.split("/").map(Number) ?? []
  if (!video || rateNumerator / rateDenominator !== MOTION_FPS)
    throw new Error(`${file} is not ${MOTION_FPS} fps`)
  if (video.width !== contract.width || video.height !== contract.height)
    throw new Error(`${file} has unexpected dimensions`)
  if (video.codec_name !== "h264" || video.pix_fmt !== "yuv420p")
    throw new Error(`${file} must use H.264 yuv420p`)
  if (Math.abs(Number(details.format.duration) - MOTION_DURATION) > 0.04)
    throw new Error(`${file} must be ${MOTION_DURATION} seconds`)
  if (details.streams.some((stream) => stream.codec_type === "audio"))
    throw new Error(`${file} unexpectedly contains audio`)
  assertFaststart(file)
  assertShortGop(file)
}

for (const [variant, width, height] of [
  ["desktop", 1920, 1080],
  ["portrait", 1080, 1920],
]) {
  for (const suffix of ["", "-web"]) {
    const master = resolve(root, "renders/masters", `assurance-world-${variant}${suffix}.mp4`)
    const details = probe(master)
    const video = details.streams.find((stream) => stream.codec_type === "video")
    if (
      !video ||
      video.width !== width ||
      video.height !== height ||
      Math.abs(Number(details.format.duration) - MOTION_DURATION) > 0.04
    )
      throw new Error(`${master} does not match the master contract`)
    if (details.streams.some((stream) => stream.codec_type === "audio"))
      throw new Error(`${master} unexpectedly contains audio`)
  }
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
  )
    throw new Error(`${file} does not match its launch-edit contract`)
  if (details.streams.some((stream) => stream.codec_type === "audio"))
    throw new Error(`${file} unexpectedly contains audio`)
  assertFaststart(file)
}

for (const variant of Object.keys(MOTION_VARIANTS)) {
  for (const chapter of MOTION_CHAPTERS) {
    for (const format of ["avif", "webp", "jpg"]) {
      const poster = resolve(output, motionPosterRelativePath(chapter, variant, format))
      if (!existsSync(poster) || statSync(poster).size === 0) throw new Error(`Missing ${poster}`)
    }
  }
}

console.log(
  "Motion V2 media verified: continuous tracks, masters, launch edits, codecs, GOPs, faststart, budgets, posters, and silence pass."
)
