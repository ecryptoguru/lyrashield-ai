import { createRequire } from "node:module"
import { mkdirSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { spawnSync } from "node:child_process"
import {
  MOTION_CHAPTERS,
  MOTION_DURATION,
  MOTION_FPS,
  MOTION_VARIANTS,
  MOTION_VERSION,
} from "../../marketing-motion/scripts/motion-media-contract.mjs"

// CI checks the real controller with reproducible synthetic video. These
// fixtures are never a visual approval or an actual-film performance receipt.
if (!process.env.CI) process.exit(0)
const require = createRequire(new URL("../../marketing-motion/package.json", import.meta.url))
const sharp = require("sharp")
const outputFlag = process.argv.indexOf("--output")
const output =
  outputFlag >= 0
    ? resolve(process.argv[outputFlag + 1])
    : resolve(`dist/client/media-local/assurance-world/v${MOTION_VERSION}/local`)
for (const [variant, contract] of Object.entries(MOTION_VARIANTS)) {
  const track = resolve(output, variant, "assurance-world.mp4")
  if (!existsSync(track)) {
    mkdirSync(dirname(track), { recursive: true })
    const result = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=0x344c64:s=${contract.width}x${contract.height}:r=${MOTION_FPS}:d=${MOTION_DURATION}`,
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-g",
        String(contract.gop),
        "-keyint_min",
        String(contract.gop),
        "-sc_threshold",
        "0",
        "-movflags",
        "+faststart",
        track,
      ],
      { stdio: "inherit" }
    )
    if (result.status !== 0) throw new Error("CI motion fixtures require ffmpeg")
  }
  for (const chapter of MOTION_CHAPTERS) {
    const poster = resolve(output, "posters", `${chapter}-${variant}.webp`)
    if (existsSync(poster)) continue
    mkdirSync(dirname(poster), { recursive: true })
    await sharp({
      create: {
        width: contract.width,
        height: contract.height,
        channels: 3,
        background: "#344c64",
      },
    })
      .webp()
      .toFile(poster)
  }
}
console.log(
  "Synthetic motion controller fixtures ready; excluded from visual and performance admission."
)
