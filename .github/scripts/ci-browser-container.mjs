import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, lstatSync, readFileSync, readdirSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { createFontArchive, FONT_FILE, FONT_FAMILIES, FONT_DATA_LIMIT } from "./fonts.mjs"

const packages = [
  "xvfb",
  "fonts-noto-color-emoji",
  "fonts-unifont",
  "libfontconfig1",
  "libfreetype6",
  "xfonts-cyrillic",
  "xfonts-scalable",
  "fonts-liberation",
  "fonts-ipafont-gothic",
  "fonts-wqy-zenhei",
  "fonts-tlwg-loma-otf",
  "fonts-freefont-ttf",
  "libasound2",
  "libatk-bridge2.0-0",
  "libatk1.0-0",
  "libatspi2.0-0",
  "libcairo2",
  "libcups2",
  "libdbus-1-3",
  "libdrm2",
  "libgbm1",
  "libglib2.0-0",
  "libnspr4",
  "libnss3",
  "libpango-1.0-0",
  "libwayland-client0",
  "libx11-6",
  "libxcb1",
  "libxcomposite1",
  "libxdamage1",
  "libxext6",
  "libxfixes3",
  "libxkbcommon0",
  "libxrandr2",
  "xfonts-encodings",
  "xfonts-utils",
]

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  })
  assert.equal(result.status, 0, `${command} preflight failed`)
  return result.stdout
}

function encode(input) {
  const { width, height, fps, duration, gop } = input
  for (const value of [width, height, fps, duration, gop])
    assert.ok(Number.isInteger(value) && value > 0)
  assert.ok(
    width <= 1920 &&
      height <= 1920 &&
      width * height <= 2_073_600 &&
      fps <= 30 &&
      duration <= 60 &&
      gop <= 60
  )
  const file = `/tmp/ci-browser/fixture-${randomUUID()}.mp4`
  try {
    run("/usr/bin/ffmpeg", [
      "-nostdin",
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=0x344c64:s=${width}x${height}:r=${fps}:d=${duration}`,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-g",
      String(gop),
      "-keyint_min",
      String(gop),
      "-sc_threshold",
      "0",
      "-movflags",
      "+faststart",
      file,
    ])
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths are restricted to the owned container temporary directory and numeric process IDs.
    const bytes = readFileSync(file)
    assert.ok(bytes.length >= 12 && bytes.length <= 32 * 1024 * 1024)
    assert.equal(bytes.toString("ascii", 4, 8), "ftyp")
    return bytes
  } finally {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths are restricted to the owned container temporary directory and numeric process IDs.
    if (existsSync(file)) unlinkSync(file)
  }
}

function verifyFonts() {
  for (const name of packages.filter(
    (name) => name.startsWith("fonts-") || name.startsWith("xfonts-") || name === "libfontconfig1"
  )) {
    assert.equal(
      run("dpkg-query", ["-W", "-f=${Status}", name]),
      "install ok installed",
      `${name} is unavailable in the pinned source image`
    )
    const changed = run("dpkg", ["-V", name])
      .split("\n")
      .filter((line) => line && !/^missing\s+\/usr\/share\/(doc|man)\//.test(line))
    assert.deepEqual(changed, [], `${name} font file integrity mismatch`)
  }
  for (const family of FONT_FAMILIES)
    assert.ok(
      run("fc-match", ["-f", "%{family}\t%{file}", family]).includes(family),
      `${family} is unavailable in the source image`
    )
}

function fontFiles(directory = "/usr/share/fonts", prefix = "") {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths are verified regular font assets in the pinned image.
  return readdirSync(directory).flatMap((name) => {
    const file = join(directory, name)
    const path = prefix ? `${prefix}/${name}` : name
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths are verified regular font assets in the pinned image.
    const stat = lstatSync(file)
    if (stat.isSymbolicLink()) return []
    if (stat.isDirectory()) return fontFiles(file, path)
    if (!FONT_FILE.test(path)) return []
    assert.ok(stat.isFile() && stat.size <= 32 * 1024 * 1024)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths are verified regular font assets in the pinned image.
    return [{ path, bytes: readFileSync(file) }]
  })
}

try {
  assert.equal(process.getuid(), 1000)
  assert.match(readFileSync("/proc/self/status", "utf8"), /^CapEff:\s+0+$/m)
  assert.match(readFileSync("/proc/self/status", "utf8"), /^NoNewPrivs:\s+1$/m)
  assert.equal(process.arch, "x64")
  const command = process.argv[2]
  if (command === "verify") {
    verifyFonts()
    assert.ok(!run("ldd", ["/usr/bin/ffmpeg"]).includes("not found"))
    encode({ width: 320, height: 180, fps: 24, duration: 1, gop: 24 })
    console.log("Pinned source font integrity, families and bounded FFmpeg runtime verified")
  } else if (command === "font-archive") {
    verifyFonts()
    const files = fontFiles()
    assert.ok(
      files.length > 0 &&
        files.length < 512 &&
        files.reduce((sum, file) => sum + file.bytes.length, 0) <= FONT_DATA_LIMIT
    )
    process.stdout.write(createFontArchive(files))
  } else if (command === "ffmpeg") process.stdout.write(encode(JSON.parse(process.argv[3])))
  else throw new Error("Unknown container verification command")
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
