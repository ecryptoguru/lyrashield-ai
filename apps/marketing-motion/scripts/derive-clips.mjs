import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { MOTION_CLIP_DURATION } from "./motion-media-contract.mjs"

/** Split on the encoder's forced one-second keyframes, without another quality loss. */
export function deriveClips(track, directory) {
  mkdirSync(directory, { recursive: true })
  const result = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      track,
      "-map",
      "0:v:0",
      "-c",
      "copy",
      "-f",
      "segment",
      "-segment_time",
      String(MOTION_CLIP_DURATION),
      "-reset_timestamps",
      "1",
      "-segment_format_options",
      "movflags=+frag_keyframe+empty_moov+default_base_moof",
      resolve(directory, "%02d.mp4"),
    ],
    { stdio: "inherit" }
  )
  if (result.status !== 0) throw new Error("Motion clip derivation failed")
}
