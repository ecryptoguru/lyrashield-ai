import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs"
import { createServer } from "node:http"
import { once } from "node:events"
import { createRequire } from "node:module"

const require = createRequire("/tmp/ci-browser/package.json")
const { chromium } = require("playwright")
const flags = ["--enable-experimental-web-platform-features", "--enable-blink-features=WebMCP"]
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

async function verifyBrowser(remote = false, full = false) {
  const payload = { verified: false, proof: "ci-browser-remote-download" }
  const server = createServer((request, response) => {
    if (request.url === "/download") {
      response.setHeader("Content-Type", "application/json")
      response.setHeader("Content-Disposition", 'attachment; filename="ci-browser-proof.json"')
      response.end(JSON.stringify(payload))
      return
    }
    response.setHeader("Content-Type", "text/html")
    response.end("<!doctype html><p>English ไทย 日本語 中文 😀</p>")
  }).listen(0, "127.0.0.1")
  await once(server, "listening")
  let browser
  try {
    const launchOptions = {
      headless: true,
      args: flags,
      ...(remote
        ? { artifactsDir: "/home/runner/work/lyrashield-ai/lyrashield-ai/test-results/preflight" }
        : {}),
      ...(full ? { executablePath: chromium.executablePath() } : {}),
    }
    browser = remote
      ? await chromium.connect("ws://127.0.0.1:31777/", {
          headers: { "x-playwright-launch-options": JSON.stringify(launchOptions) },
          timeout: 30_000,
        })
      : await chromium.launch(launchOptions)
    assert.equal(browser.version(), "151.0.7922.34")
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    assert.deepEqual(
      await page.evaluate(() => ({
        context: !!document.modelContext,
        register: typeof document.modelContext?.registerTool === "function",
        tools: typeof document.modelContext?.getTools === "function",
        execute: typeof document.modelContext?.executeTool === "function",
      })),
      { context: true, register: true, tools: true, execute: true }
    )
    if (remote) {
      const downloadEvent = page.waitForEvent("download")
      await page.evaluate(() => {
        const anchor = document.createElement("a")
        anchor.href = "/download"
        document.body.append(anchor)
        anchor.click()
      })
      const download = await downloadEvent
      assert.equal(download.suggestedFilename(), "ci-browser-proof.json")
      const file = `/tmp/ci-browser/download-${randomUUID()}.json`
      try {
        await download.saveAs(file)
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- The download uses a random filename in the owned container temporary directory.
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), payload)
      } finally {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- The download uses a random filename in the owned container temporary directory.
        if (existsSync(file)) unlinkSync(file)
      }
    }
    const commands = readdirSync("/proc")
      .filter((entry) => /^\d+$/.test(entry))
      .flatMap((pid) => {
        try {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths are restricted to the owned container temporary directory and numeric process IDs.
          return [readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")]
        } catch {
          return []
        }
      })
    assert.ok(
      commands.some(
        (command) =>
          command.some((arg) => arg.startsWith("/ms-playwright/chromium")) &&
          flags.every((flag) => command.includes(flag))
      ),
      "Native WebMCP launch flags were not honored"
    )
  } finally {
    await browser?.close()
    server.close()
    await once(server, "close")
  }
}

try {
  assert.equal(process.getuid(), 1000)
  assert.match(readFileSync("/proc/self/status", "utf8"), /^CapEff:\s+0+$/m)
  assert.match(readFileSync("/proc/self/status", "utf8"), /^NoNewPrivs:\s+1$/m)
  assert.equal(process.arch, "x64")
  for (const name of ["playwright", "playwright-core"])
    assert.equal(require(`${name}/package.json`).version, "1.62.1")
  const browsers = JSON.parse(
    readFileSync("/tmp/ci-browser/node_modules/playwright-core/browsers.json", "utf8")
  ).browsers
  for (const name of ["chromium", "chromium-headless-shell"]) {
    const browser = browsers.find((entry) => entry.name === name)
    assert.equal(browser.revision, "1234")
    assert.equal(browser.browserVersion, "151.0.7922.34")
  }
  const command = process.argv[2]
  if (command === "verify") {
    for (const name of packages)
      assert.equal(
        run("dpkg-query", ["-W", "-f=${Status}", name]),
        "install ok installed",
        `${name} is unavailable`
      )
    for (const name of packages.filter(
      (name) => name.startsWith("fonts-") || name.startsWith("xfonts-")
    )) {
      const output = run("dpkg", ["-V", name])
        .split("\n")
        .filter((line) => line && !/^missing\s+\/usr\/share\/(doc|man)\//.test(line))
      assert.deepEqual(output, [], `${name} font file integrity mismatch`)
    }
    for (const family of [
      "FreeSans",
      "IPAGothic",
      "Loma",
      "Unifont",
      "WenQuanYi Zen Hei",
      "Noto Color Emoji",
      "Liberation Sans",
    ])
      assert.ok(
        run("fc-match", ["-f", "%{family}\t%{file}", family]).includes(family),
        `${family} is unavailable`
      )
    for (const binary of [
      chromium.executablePath(),
      "/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell",
      "/usr/bin/ffmpeg",
    ])
      assert.ok(
        !run("ldd", [binary]).includes("not found"),
        "Browser native library is unavailable"
      )
    encode({ width: 320, height: 180, fps: 24, duration: 1, gop: 24 })
    await verifyBrowser()
    await verifyBrowser(false, true)
    console.log("CI browser image, packages, fonts, native libraries, FFmpeg and Chromium verified")
  } else if (command === "verify-server") {
    await verifyBrowser(true)
    console.log(
      "CI loopback browser server honored native WebMCP flags and remote download artifacts"
    )
  } else if (command === "ffmpeg") process.stdout.write(encode(JSON.parse(process.argv[3])))
  else throw new Error("Unknown container verification command")
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
