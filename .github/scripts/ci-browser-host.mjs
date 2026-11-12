import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, realpathSync, lstatSync, statfsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { createServer } from "node:http"
import { once } from "node:events"
import { FONT_FAMILIES } from "./ci-browser-fonts.mjs"
import { browserFailureReason } from "./ci-browser.mjs"

const require = createRequire(import.meta.url)
const playwright = createRequire(require.resolve("@playwright/test/package.json")).resolve(
  "playwright/package.json"
)
const core = createRequire(playwright).resolve("playwright-core/package.json")
const { chromium } = createRequire(core)("playwright-core")
const flags = ["--enable-experimental-web-platform-features", "--enable-blink-features=WebMCP"]
let phase = "runtime"
let item = "none"

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  })
  assert.equal(result.status, 0, `${command} host runtime check failed`)
  return result.stdout
}

async function probeTraceLifecycle(
  browser,
  server,
  index,
  browserTemp,
  bytesIn,
  peakTemporaryBytes
) {
  // Exercise the original local artifact lifecycle. Successful traces
  // may grow during a browser lifetime, then must disappear on close.
  for (let iteration = 0; iteration < 3; iteration++) {
    phase = "trace-context"
    item = String(index * 3 + iteration)
    const context = await browser.newContext()
    let traceFailed = false
    try {
      phase = "trace-start"
      await context.tracing.start({ snapshots: true, screenshots: true })
      phase = "trace-page"
      const probe = await context.newPage()
      phase = "trace-goto"
      await probe.goto(`http://127.0.0.1:${server.address().port}`)
      phase = "trace-screenshot"
      await probe.screenshot()
      phase = "trace-stop"
      await context.tracing.stop()
      phase = "trace-size"
      peakTemporaryBytes = Math.max(peakTemporaryBytes, bytesIn(browserTemp))
    } catch (error) {
      traceFailed = true
      throw error
    } finally {
      try {
        await context.close()
      } catch (error) {
        if (!traceFailed) {
          phase = "trace-close"
          throw error
        }
      }
    }
  }
  return peakTemporaryBytes
}

async function verify() {
  item = "0"
  assert.equal(process.platform, "linux")
  item = "1"
  assert.equal(process.arch, "x64")
  item = "2"
  assert.notEqual(process.getuid(), 0)
  item = "3"
  assert.equal(require("@playwright/test/package.json").version, "1.62.1")
  item = "4"
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from locked packages or the validated private CI font and trace directories.
  assert.equal(JSON.parse(readFileSync(core, "utf8")).version, "1.62.1")
  phase = "manifest"
  item = "0"
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from locked packages or the validated private CI font and trace directories.
  const directory = realpathSync(process.argv[2])
  item = "1"
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from locked packages or the validated private CI font and trace directories.
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"))
  for (const [index, file] of manifest.files.entries()) {
    item = String(index)
    phase = "font-hash"
    const path = join(directory, "fonts", file.path)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from locked packages or the validated private CI font and trace directories.
    assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"), file.sha256)
    // Fontconfig does not decode these legacy X11 PCF encodings, including in
    // the pinned source image. Their exact bytes are hash-bound above; every
    // scalable Chromium font still must pass fc-scan.
    if (/\.(?:ttf|ttc|otf|pfb|t1)$/.test(file.path)) {
      phase = "font-scan"
      assert.ok(run("fc-scan", ["--format", "%{family}", path]).trim(), "Font asset is unreadable")
    }
  }
  phase = "font-family"
  for (const [index, family] of FONT_FAMILIES.entries()) {
    item = String(index * 2)
    const [actual, path] = run("fc-match", ["--format", "%{family}\t%{file}", family]).split("\t")
    assert.ok(actual.includes(family), `${family} is unavailable`)
    item = String(index * 2 + 1)
    assert.ok(
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from locked packages or the validated private CI font and trace directories.
      manifest.files.some((file) => join(directory, "fonts", file.path) === realpathSync(path)),
      `${family} did not resolve to a verified overlay font`
    )
  }
  phase = "browser-identity"
  item = "0"
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from locked packages or the validated private CI font and trace directories.
  const browsers = JSON.parse(readFileSync(join(dirname(core), "browsers.json"), "utf8")).browsers
  const full = chromium.executablePath()
  item = "1"
  assert.ok(
    full.endsWith("/chromium-1234/chrome-linux64/chrome"),
    "Unexpected locked Chromium cache path"
  )
  const binaries = [
    join(
      dirname(dirname(dirname(full))),
      "chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell"
    ),
  ]
  // Every selected CI suite uses Playwright's default headless shell. Full
  // Chromium is downloaded by the unchanged install command but is not used.
  for (const [index, name] of ["chromium-headless-shell"].entries()) {
    const browser = browsers.find((entry) => entry.name === name)
    item = String(index * 2 + 2)
    assert.equal(browser.revision, "1234")
    item = String(index * 2 + 3)
    assert.equal(browser.browserVersion, "151.0.7922.34")
  }
  phase = "native-libraries"
  for (const [index, binary] of binaries.entries()) {
    item = String(index)
    assert.ok(
      !run("ldd", [binary]).includes("not found"),
      "Host Chromium native library is unavailable"
    )
  }
  phase = "browser-temp"
  item = "none"
  const browserTemp = join(directory, "browser-tmp")
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from locked packages or the validated private CI font and trace directories.
  mkdirSync(browserTemp, { mode: 0o700 })
  process.env.TMPDIR = browserTemp
  let peakTemporaryBytes = 0
  const bytesIn = (path) =>
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from locked packages or the validated private CI font and trace directories.
    readdirSync(path).reduce((total, name) => {
      const file = join(path, name)
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from locked packages or the validated private CI font and trace directories.
      const stat = lstatSync(file)
      return total + (stat.isSymbolicLink() ? 0 : stat.isDirectory() ? bytesIn(file) : stat.size)
    }, 0)
  phase = "loopback-server"
  const server = createServer((_request, response) =>
    response.end("<!doctype html><p>English ไทย 日本語 中文 😀</p>")
  ).listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    for (const [index, binary] of binaries.entries()) {
      phase = "browser-launch"
      item = String(index)
      const browser = await chromium.launch({ executablePath: binary, args: flags })
      try {
        phase = "browser-identity"
        item = String(index + 6)
        assert.equal(browser.version(), "151.0.7922.34")
        phase = "webmcp"
        item = String(index * 2)
        const page = await browser.newPage()
        await page.goto(`http://127.0.0.1:${server.address().port}`)
        item = String(index * 2 + 1)
        assert.deepEqual(
          await page.evaluate(() => ({
            context: !!document.modelContext,
            tools: typeof document.modelContext?.getTools === "function",
            execute: typeof document.modelContext?.executeTool === "function",
          })),
          { context: true, tools: true, execute: true }
        )
        await page.close()
        peakTemporaryBytes = await probeTraceLifecycle(
          browser,
          server,
          index,
          browserTemp,
          bytesIn,
          peakTemporaryBytes
        )
      } finally {
        await browser.close()
      }
      phase = "artifact-cleanup"
      item = String(index)
      assert.deepEqual(
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from locked packages or the validated private CI font and trace directories.
        readdirSync(browserTemp),
        [],
        "Local browser temporary artifacts were not reclaimed"
      )
    }
  } finally {
    server.close()
    await once(server, "close")
  }
  phase = "resource-telemetry"
  item = "none"
  const available = statfsSync(browserTemp)
  console.log(
    `Verified ${manifest.files.length} pinned font assets, overlay families, host libraries and native WebMCP headless shell; bounded lifecycle probe peak=${peakTemporaryBytes} bytes, available=${available.bavail * available.bsize} bytes`
  )
}

verify().catch((error) => {
  const reason = browserFailureReason(error)
  console.error(`CI_BROWSER_CHECK_FAILED phase=${phase} item=${item} reason=${reason}`)
  process.exitCode = 1
})
