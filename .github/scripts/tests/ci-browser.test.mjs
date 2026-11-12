import assert from "node:assert/strict"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { createRequire } from "node:module"
import { createFontArchive } from "../ci-browser-fonts.mjs"
import {
  BROWSER_IMAGE,
  browserFailureReason,
  hostFailureDiagnostic,
  runCommand,
  startBrowser,
  stopBrowser,
  prepareFfmpeg,
  syntheticFixture,
  transcodeFixture,
} from "../ci-browser.mjs"
import {
  MOTION_DURATION,
  MOTION_FPS,
  MOTION_VARIANTS,
  MOTION_VERSION,
} from "../../../apps/marketing-motion/scripts/motion-media-contract.mjs"
const { parse } = createRequire(
  new URL("../../../packages/agent-plugin/package.json", import.meta.url)
)("yaml")

const id = "a".repeat(64)
test("browser errors expose only fixed failure categories", () => {
  assert.equal(browserFailureReason({ name: "TimeoutError", message: "private URL" }), "timeout")
  assert.equal(
    browserFailureReason({
      message: "page.screenshot: Target page, context or browser has been closed; secret",
    }),
    "target-closed"
  )
  assert.equal(browserFailureReason({ message: "Protocol error: private detail" }), "protocol")
  assert.equal(
    browserFailureReason({ message: "net::ERR_CONNECTION_RESET private URL" }),
    "network"
  )
  assert.equal(browserFailureReason({ code: "ENOSPC", message: "private path" }), "ENOSPC")
  assert.equal(browserFailureReason({ message: "private secret" }), "unavailable")
})
test("host failure diagnostics propagate only bounded fixed fields, never child secrets", () => {
  const diagnostic = "CI_BROWSER_CHECK_FAILED phase=native-libraries item=0 reason=assertion"
  assert.equal(
    hostFailureDiagnostic(`secret=do-not-print\n${diagnostic}\nraw private stderr`),
    diagnostic
  )
  for (const phase of [
    "trace-context",
    "trace-start",
    "trace-page",
    "trace-goto",
    "trace-screenshot",
    "trace-stop",
    "trace-size",
    "trace-close",
  ]) {
    const traceDiagnostic = `CI_BROWSER_CHECK_FAILED phase=${phase} item=2 reason=target-closed`
    assert.equal(hostFailureDiagnostic(`secret=hidden\n${traceDiagnostic}`), traceDiagnostic)
  }
  for (const unsafe of [
    "CI_BROWSER_CHECK_FAILED phase=secret-value item=0 reason=assertion",
    "CI_BROWSER_CHECK_FAILED phase=font-scan item=1000 reason=assertion",
    `${diagnostic} secret=do-not-print`,
    "CI_BROWSER_CHECK_FAILED phase=font-scan item=0 reason=private-error",
    "private child stderr only",
  ])
    assert.equal(hostFailureDiagnostic(unsafe), undefined)
})
test("real failed child propagates only the opted-in host diagnostic", () => {
  const diagnostic = "CI_BROWSER_CHECK_FAILED phase=font-scan item=12 reason=assertion"
  const args = [
    "-e",
    `process.stderr.write("private-child-secret\\n${diagnostic}\\n");process.exit(1)`,
  ]
  assert.throws(
    () => runCommand(process.execPath, args, { hostDiagnostic: true }),
    (error) => error.message.endsWith(diagnostic) && !error.message.includes("private-child-secret")
  )
  assert.throws(
    () => runCommand(process.execPath, args),
    (error) =>
      !error.message.includes(diagnostic) && !error.message.includes("private-child-secret")
  )
})
function fixture(options = {}) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The test owns the temporary directory and all fixture paths.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ci-browser-test-")))
  const env = {
    GITHUB_ACTIONS: "true",
    RUNNER_OS: "Linux",
    RUNNER_ARCH: "X64",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_JOB: "app-core-tests",
    RUNNER_TEMP: dir,
    GITHUB_ENV: join(dir, "env"),
    GITHUB_PATH: join(dir, "path"),
    BREVO_API_KEY: "must-not-enter-container",
    DATABASE_URL: "must-not-enter-container",
  }
  const calls = []
  let removed = false
  let searches = 0
  const run = (command, args, config = {}) => {
    calls.push({ command, args, config })
    if (command === "ffmpeg") {
      if (options.hostFfmpeg) return ""
      throw new Error("host FFmpeg unavailable")
    }
    if (args.includes("font-archive")) {
      if (options.failTransfer) throw new Error("font archive transfer failed")
      return createFontArchive([
        { path: "truetype/freefont/FreeSans.ttf", bytes: Buffer.from("verified-font-fixture") },
      ])
    }
    if (command === "node" && args[0].endsWith("ci-browser-host.mjs")) {
      if (options.substituteState) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- The test owns all fixture paths.
        writeFileSync(join(dir, "ci-browser-123-2-app-core-tests.json"), options.substituteState)
        throw new Error("host check failed after state substitution")
      }
      if (options.failHost) throw new Error("host native runtime unavailable")
    }
    if (command === "node" && args.includes("install") && options.failInstall)
      throw new Error("browser binary install unavailable")
    if (args[0] === "image")
      return JSON.stringify([
        {
          Architecture: options.arch ?? "amd64",
          Os: "linux",
          RepoDigests: [options.image ?? BROWSER_IMAGE],
        },
      ])
    if (args[0] === "run") {
      if (options.missingStateDirectory) rmSync(dir, { recursive: true })
      if (options.lostAcknowledgement) throw new Error("Docker create acknowledgement lost")
      return options.badAcknowledgement ? "unusable-id" : `${id}\n`
    }
    if (args[0] === "ps") {
      searches++
      return removed || options.noContainer || (options.delayedCreation && searches === 1)
        ? ""
        : `${id}\n`
    }
    if (args[0] === "rm") removed = true
    if (args[0] === "inspect")
      return JSON.stringify([
        {
          Id: id,
          Name: "/lyrashield-ci-browser-123-2-app-core-tests",
          Config: {
            Image: BROWSER_IMAGE,
            Labels: {
              "lyrashield.ci-browser": options.foreign ? "other-run" : "123-2-app-core-tests",
            },
          },
        },
      ])
    if (args.includes("verify") && options.failVerify) throw new Error("native dependency missing")
    if (args.includes("verify-server") && options.failServer) throw new Error("WebMCP unavailable")
    if (config.binary) return options.bytes ?? Buffer.from("0000ftyp000000000000000000000000")
    return ""
  }
  const input = {
    env,
    run,
    packages: () => ["/locked/playwright", "/locked/playwright-core"],
  }
  return { dir, env, run, calls, input, clean: () => rmSync(dir, { recursive: true, force: true }) }
}

test("extracts pinned fonts without a remote browser and validates the local host runtime", async () => {
  const f = fixture()
  try {
    await startBrowser(f.input)
    const pull = f.calls.find((call) => call.args[0] === "pull")
    assert.deepEqual(pull.args, ["pull", "--platform", "linux/amd64", BROWSER_IMAGE])
    const args = f.calls.find((call) => call.args[0] === "run").args
    for (const pair of [
      ["--user", "1000:1000"],
      ["--cap-drop", "ALL"],
      ["--network", "none"],
      ["--security-opt", "no-new-privileges"],
      ["--shm-size", "512m"],
      ["--tmpfs", "/tmp:rw,nosuid,nodev,size=512m"],
    ])
      assert.equal(args[args.indexOf(pair[0]) + 1], pair[1])
    assert.ok(args.includes("--read-only"))
    for (const forbidden of [
      "--privileged",
      "--mount",
      "-v",
      "--ipc",
      "--env-file",
      f.env.BREVO_API_KEY,
      f.env.DATABASE_URL,
      "/var/run/docker.sock",
    ])
      assert.ok(!args.includes(forbidden), forbidden)
    assert.deepEqual(args.slice(args.indexOf("--env"), args.indexOf("--env") + 2), [
      "--env",
      "HOME=/tmp",
    ])
    assert.ok(
      !f.calls.some((call) => call.args.includes("run-server") || call.args.includes("--unsafe"))
    )
    const host = f.calls.find(
      (call) => call.command === "node" && call.args[0].endsWith("ci-browser-host.mjs")
    )
    assert.ok(host)
    assert.equal(host.config.hostDiagnostic, true)
    assert.ok(f.calls.filter((call) => call !== host).every((call) => !call.config.hostDiagnostic))
    const config = host.config.env.FONTCONFIG_FILE
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The test owns all fixture paths.
    assert.equal(readFileSync(f.env.GITHUB_ENV, "utf8"), `FONTCONFIG_FILE=${config}\n`)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The test owns all fixture paths.
    assert.ok(!readFileSync(f.env.GITHUB_ENV, "utf8").includes("PW_TEST_CONNECT_WS_ENDPOINT"))
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The test owns all fixture paths.
    assert.ok(readFileSync(config, "utf8").includes("/etc/fonts/fonts.conf"))
    assert.deepEqual(
      f.calls.find((call) => call.command === "node" && call.args.includes("install")).args,
      ["/locked/playwright/cli.js", "install", "chromium"]
    )
    assert.ok(
      f.calls.findIndex((call) => call.args.includes("font-archive")) < f.calls.indexOf(host)
    )
    assert.ok(
      f.calls
        .filter((call) => call.args.includes("--interactive"))
        .every((call) => Buffer.isBuffer(call.config.input))
    )
    stopBrowser(f.input)
    assert.deepEqual(f.calls.at(-1).args, ["rm", "--force", id])
    stopBrowser(f.input)
  } finally {
    f.clean()
  }
})

for (const failure of ["failTransfer", "failVerify", "failInstall", "failHost"])
  test(`${failure} fails closed, removes only its container and publishes no font configuration`, async () => {
    const f = fixture({ [failure]: true })
    try {
      await assert.rejects(startBrowser(f.input))
      assert.deepEqual(f.calls.at(-1).args, ["rm", "--force", id])
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- The test owns the temporary directory and all fixture paths.
      assert.equal(existsSync(f.env.GITHUB_ENV), false)
    } finally {
      f.clean()
    }
  })

test("ENOENT while publishing state still removes the exact owned container", async () => {
  const f = fixture({ missingStateDirectory: true })
  try {
    await assert.rejects(startBrowser(f.input), { code: "ENOENT" })
    assert.deepEqual(f.calls.at(-1).args, ["rm", "--force", id])
    assert.ok(!f.calls.some((call) => call.args.includes("verify")))
  } finally {
    f.clean()
  }
})

test("ENOSPC while publishing state still removes the exact owned container", async () => {
  const f = fixture()
  try {
    await assert.rejects(
      startBrowser({
        ...f.input,
        writeState: () => {
          throw Object.assign(new Error("state disk full"), { code: "ENOSPC" })
        },
      }),
      { code: "ENOSPC" }
    )
    assert.deepEqual(f.calls.at(-1).args, ["rm", "--force", id])
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The test owns the temporary environment path.
    assert.equal(existsSync(f.env.GITHUB_ENV), false)
  } finally {
    f.clean()
  }
})

test("foreign state substitution cannot redirect startup cleanup", async () => {
  const foreign = JSON.stringify({
    id: "b".repeat(64),
    name: "lyrashield-ci-browser-123-2-app-core-tests",
    image: BROWSER_IMAGE,
  })
  const f = fixture({ substituteState: foreign })
  try {
    await assert.rejects(startBrowser(f.input), /state substitution/)
    assert.deepEqual(f.calls.at(-1).args, ["rm", "--force", id])
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The test owns the temporary state path.
    assert.equal(readFileSync(join(f.dir, "ci-browser-123-2-app-core-tests.json"), "utf8"), foreign)
  } finally {
    f.clean()
  }
})

for (const option of ["lostAcknowledgement", "badAcknowledgement"])
  test(`${option} resolves only the preselected name and removes its verified full ID`, async () => {
    const f = fixture({ [option]: true })
    try {
      await assert.rejects(startBrowser(f.input))
      assert.deepEqual(f.calls.find((call) => call.args[0] === "ps").args, [
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        "name=^/lyrashield-ci-browser-123-2-app-core-tests$",
        "--format",
        "{{.ID}}",
      ])
      assert.deepEqual(f.calls.at(-1).args, ["rm", "--force", id])
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- The test owns the temporary environment path.
      assert.equal(existsSync(f.env.GITHUB_ENV), false)
    } finally {
      f.clean()
    }
  })

test("ambiguous creation refuses a foreign container at the preselected name", async () => {
  const f = fixture({ lostAcknowledgement: true, foreign: true })
  try {
    await assert.rejects(startBrowser(f.input), /unowned/)
    assert.ok(!f.calls.some((call) => call.args[0] === "rm"))
  } finally {
    f.clean()
  }
})

test("lost acknowledgement with no created container needs no deletion", async () => {
  const f = fixture({ lostAcknowledgement: true, noContainer: true })
  try {
    await assert.rejects(startBrowser(f.input), /acknowledgement lost/)
    assert.ok(!f.calls.some((call) => call.args[0] === "rm"))
  } finally {
    f.clean()
  }
})

test("always cleanup can find late creation without any published state", async () => {
  const f = fixture({ lostAcknowledgement: true, delayedCreation: true })
  try {
    await assert.rejects(startBrowser(f.input), /acknowledgement lost/)
    assert.ok(!f.calls.some((call) => call.args[0] === "rm"))
    stopBrowser(f.input)
    assert.deepEqual(f.calls.at(-1).args, ["rm", "--force", id])
    stopBrowser(f.input)
    assert.equal(f.calls.filter((call) => call.args[0] === "rm").length, 1)
  } finally {
    f.clean()
  }
})

for (const option of [{ arch: "arm64" }, { image: "unqualified" }])
  test(`rejects unqualified image ${JSON.stringify(option)}`, async () => {
    const f = fixture(option)
    try {
      await assert.rejects(startBrowser(f.input), /image identity/)
      assert.ok(!f.calls.some((call) => call.args[0] === "run"))
    } finally {
      f.clean()
    }
  })

test("refuses foreign-container cleanup", async () => {
  const f = fixture({ foreign: true })
  try {
    await startBrowser(f.input)
    assert.throws(() => stopBrowser(f.input), /unowned/)
    assert.ok(!f.calls.some((call) => call.args[0] === "rm"))
  } finally {
    f.clean()
  }
})

test("refuses a substituted font directory before container or file removal", async () => {
  const f = fixture()
  try {
    await startBrowser(f.input)
    const statePath = join(f.dir, "ci-browser-123-2-app-core-tests.json")
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The test owns the state and foreign fixture directories.
    const state = JSON.parse(readFileSync(statePath, "utf8"))
    const foreign = join(f.dir, "ci-fonts-123-2-app-core-tests-foreign")
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The test owns this foreign-directory fixture.
    mkdirSync(foreign)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The test owns this foreign-directory fixture.
    writeFileSync(
      join(foreign, ".ci-owned.json"),
      JSON.stringify({ id: "b".repeat(64), scope: "123-2-app-core-tests", image: BROWSER_IMAGE })
    )
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The test owns the temporary state path.
    writeFileSync(statePath, JSON.stringify({ ...state, fontDir: foreign }))
    assert.throws(() => stopBrowser(f.input), /unowned font/)
    assert.ok(!f.calls.some((call) => call.args[0] === "rm"))
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The test owns this foreign-directory fixture.
    assert.ok(existsSync(foreign))
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Restore the original owned fixture state for cleanup.
    writeFileSync(statePath, JSON.stringify(state))
    stopBrowser(f.input)
  } finally {
    f.clean()
  }
})

test("refuses non-GitHub or non-Linux/X64 execution before Docker", async () => {
  for (const change of [
    { GITHUB_ACTIONS: "false" },
    { RUNNER_OS: "macOS" },
    { RUNNER_ARCH: "ARM64" },
  ]) {
    const f = fixture()
    try {
      await assert.rejects(startBrowser({ ...f.input, env: { ...f.env, ...change } }), /Linux X64/)
      assert.equal(f.calls.length, 0)
    } finally {
      f.clean()
    }
  }
})

test("keeps validated host FFmpeg and adds a fallback only when its real encoder probe fails", async () => {
  const host = fixture({ hostFfmpeg: true })
  const fallback = fixture()
  try {
    prepareFfmpeg(host.input)
    assert.equal(host.calls.length, 1)
    assert.ok(host.calls[0].args.includes("lavfi") && host.calls[0].args.includes("libx264"))
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The test owns the temporary directory and all fixture paths.
    assert.equal(existsSync(host.env.GITHUB_PATH), false)
    await startBrowser(fallback.input)
    prepareFfmpeg(fallback.input)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The test owns the temporary directory and all fixture paths.
    const path = readFileSync(fallback.env.GITHUB_PATH, "utf8").trim()
    assert.match(
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- The test owns the temporary directory and all fixture paths.
      readFileSync(join(path, "ffmpeg"), "utf8"),
      /exec node .*ci-browser\.mjs' ffmpeg "\$@"/
    )
  } finally {
    host.clean()
    fallback.clean()
  }
})

function ffmpegArgs(dir, variant) {
  const c = MOTION_VARIANTS[variant]
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x344c64:s=${c.width}x${c.height}:r=${MOTION_FPS}:d=${MOTION_DURATION}`,
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(c.gop),
    "-keyint_min",
    String(c.gop),
    "-sc_threshold",
    "0",
    "-movflags",
    "+faststart",
    join(
      dir,
      `apps/marketing/dist/client/media-local/assurance-world/v${MOTION_VERSION}/local/${variant}/assurance-world.mp4`
    ),
  ]
}

for (const variant of Object.keys(MOTION_VARIANTS))
  test(`bounds the ${variant} fallback to its synthetic command and returns MP4 bytes without mounts`, async () => {
    const f = fixture()
    try {
      await startBrowser(f.input)
      const args = ffmpegArgs(f.dir, variant)
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- The test owns the temporary directory and all fixture paths.
      mkdirSync(dirname(args.at(-1)), { recursive: true })
      transcodeFixture(args, { ...f.input, repoRoot: f.dir })
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- The test owns the temporary directory and all fixture paths.
      assert.equal(readFileSync(args.at(-1)).toString("ascii", 4, 8), "ftyp")
      const call = f.calls.at(-1)
      assert.equal(call.args[0], "exec")
      assert.equal(call.config.binary, true)
      assert.equal(call.config.timeout, 120_000)
      assert.ok(!call.args.includes("--mount") && !call.args.includes(args.at(-1)))
      assert.equal(JSON.parse(call.args.at(-1)).duration, MOTION_DURATION)
      for (const mutated of [
        [...args.slice(0, -1), "/tmp/out.mp4"],
        args.map((value) => (value.startsWith("color=") ? "http://target.example/" : value)),
        ["-version"],
      ])
        assert.throws(() => syntheticFixture(mutated, f.dir), /only the current synthetic/)
    } finally {
      f.clean()
    }
  })

test("rejects malformed MP4 and output symlinks without writing a fixture", async () => {
  const f = fixture({ bytes: Buffer.from("not MP4") })
  try {
    await startBrowser(f.input)
    const args = ffmpegArgs(f.dir, "desktop")
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The test owns the temporary directory and all fixture paths.
    mkdirSync(dirname(args.at(-1)), { recursive: true })
    assert.throws(() => transcodeFixture(args, { ...f.input, repoRoot: f.dir }), /bounded MP4/)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The test owns the temporary directory and all fixture paths.
    assert.equal(existsSync(args.at(-1)), false)
    const parent = dirname(args.at(-1))
    rmSync(parent, { recursive: true })
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The test owns the temporary directory and all fixture paths.
    symlinkSync(f.dir, parent)
    assert.throws(() => transcodeFixture(args, { ...f.input, repoRoot: f.dir }), /symlinks/)
  } finally {
    f.clean()
  }
})

test("all three CI sites preserve selected browser commands, aggregate and privacy diagnostics", () => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"))
  const jobs = workflow.jobs
  const browserJobs = Object.values(jobs).filter((job) =>
    job.steps?.some((step) => step.run === "node .github/scripts/ci-browser.mjs start")
  )
  assert.equal(browserJobs.length, 3)
  assert.deepEqual(
    browserJobs.map(
      (job) => job.steps.find((step) => step.run === "node .github/scripts/ci-browser.mjs start").if
    ),
    [
      "needs.changes.outputs.app == 'true' || needs.changes.outputs.database-tests == 'true'",
      "needs.changes.outputs.marketing-tests == 'true'",
      "needs.changes.outputs.app != 'true' && needs.changes.outputs.shared != 'true'",
    ]
  )
  for (const job of browserJobs) {
    assert.equal(job["runs-on"], "ubuntu-latest")
    const cleanup = job.steps.find(
      (step) => step.run === "node .github/scripts/ci-browser.mjs stop"
    )
    assert.equal(cleanup.if, "${{ always() }}")
    assert.ok(
      job.steps.indexOf(cleanup) >
        job.steps.findLastIndex(
          (step) =>
            step.run?.includes("test:browser") ||
            step.run?.includes("playwright test") ||
            step.run?.includes("test:auth-mail-browser")
        )
    )
    assert.ok(!job.steps.some((step) => step.run?.includes("playwright install --with-deps")))
  }
  const text = readFileSync(".github/workflows/ci.yml", "utf8")
  for (const command of [
    "pnpm exec playwright test",
    "pnpm test:browser-harness",
    "pnpm test:auth-mail-browser",
    "pnpm --filter @lyrashield/marketing test:browser",
  ])
    assert.ok(text.includes(command))
  assert.equal(jobs["lint-and-typecheck"].name, "Lint, Typecheck, Test & Build")
  const marketing = browserJobs.find((job) => job.name === "Marketing & Motion")
  assert.ok(
    marketing.steps.some(
      (step) => step.run === "node .github/scripts/ci-browser.mjs prepare-ffmpeg"
    )
  )
  assert.ok(
    marketing.steps.some((step) => step.name === "Retain marketing browser failure diagnostics")
  )
  const privacy = readFileSync(".github/scripts/run-auth-mail-browser-proof.mjs", "utf8")
  assert.ok(
    privacy.includes(
      "childEnvironment.DEBUG || childEnvironment.PWDEBUG || childEnvironment.PW_TEST_DEBUG"
    )
  )
})

test("CI preflight checks the headless shell used by every selected browser suite", () => {
  for (const path of [
    "playwright.config.ts",
    "e2e/browser/playwright.config.ts",
    "e2e/auth-mail/playwright.config.ts",
    "e2e/simplification-recovery.spec.ts",
    "apps/marketing/playwright.config.ts",
  ]) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- These are fixed reviewed repository configurations.
    const config = readFileSync(path, "utf8")
    assert.ok(!/headless:\s*false|channel:\s*["'](?:chrome|chromium)/.test(config), path)
    for (const override of config.match(/executablePath:[^\n]+/g) ?? [])
      assert.ok(override.includes("process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"), path)
  }
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8")
  assert.ok(!workflow.includes("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"))
  assert.ok(!workflow.includes("PWDEBUG"))
  const host = readFileSync(".github/scripts/ci-browser-host.mjs", "utf8")
  assert.match(host, /const binaries = \[\s*join\(/)
  assert.ok(host.includes('["chromium-headless-shell"].entries()'))
  assert.ok(host.includes('"--enable-experimental-web-platform-features"'))
  assert.ok(host.includes('"--enable-blink-features=WebMCP"'))
})
