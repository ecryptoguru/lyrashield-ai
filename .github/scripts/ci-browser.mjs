import { spawnSync } from "node:child_process"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { fontconfigOverlay, unpackFonts, FONT_COMPRESSED_LIMIT } from "./ci-browser-fonts.mjs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  MOTION_DURATION,
  MOTION_FPS,
  MOTION_VARIANTS,
  MOTION_VERSION,
} from "../../apps/marketing-motion/scripts/motion-media-contract.mjs"

export const BROWSER_IMAGE =
  "mcr.microsoft.com/playwright@sha256:75d2d72c89da49d06aa7f6e623987392019aebbc52c09fd8cd6e2c94c7c7d71d"
export const BROWSER_VERSION = "1.62.1"
const root = fileURLToPath(new URL("../..", import.meta.url))
const require = createRequire(import.meta.url)
const label = "lyrashield.ci-browser"
const maxBuffer = 32 * 1024 * 1024

export function browserFailureReason(error) {
  if (["ENOENT", "EACCES", "ENOSPC", "EIO", "ETIMEDOUT"].includes(error?.code)) return error.code
  if (error?.name === "AssertionError") return "assertion"
  if (error?.name === "TimeoutError") return "timeout"
  const message = typeof error?.message === "string" ? error.message : ""
  if (message.includes("Target page, context or browser has been closed")) return "target-closed"
  if (message.includes("Protocol error")) return "protocol"
  if (/\bnet::ERR_[A-Z0-9_]+\b/.test(message)) return "network"
  return "unavailable"
}

export function hostFailureDiagnostic(stderr) {
  return String(stderr ?? "")
    .split("\n")
    .find((line) =>
      /^CI_BROWSER_CHECK_FAILED phase=(runtime|manifest|font-hash|font-scan|font-family|browser-identity|native-libraries|browser-temp|loopback-server|browser-launch|webmcp|trace-lifecycle|trace-context|trace-start|trace-page|trace-goto|trace-screenshot|trace-stop|trace-size|trace-close|artifact-cleanup|resource-telemetry) item=(none|\d{1,3}) reason=(assertion|ENOENT|EACCES|ENOSPC|EIO|ETIMEDOUT|timeout|target-closed|protocol|network|unavailable)$/.test(
        line
      )
    )
}

export function runCommand(
  command,
  args,
  {
    timeout = 30_000,
    binary = false,
    input,
    env,
    outputLimit = maxBuffer,
    hostDiagnostic = false,
  } = {}
) {
  const result = spawnSync(command, args, {
    encoding: binary ? null : "utf8",
    timeout,
    maxBuffer: outputLimit,
    input,
    env,
  })
  if (result.error || result.status !== 0) {
    const diagnostic = hostDiagnostic ? hostFailureDiagnostic(result.stderr) : undefined
    throw new Error(
      `${command} ${args[0]} failed; exit ${result.status ?? "unavailable"}${diagnostic ? `; ${diagnostic}` : ""}`
    )
  }
  return result.stdout
}

function context(env) {
  if (env.GITHUB_ACTIONS !== "true" || env.RUNNER_OS !== "Linux" || env.RUNNER_ARCH !== "X64")
    throw new Error("CI browser requires a GitHub Linux X64 runner")
  const scope = `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${env.GITHUB_JOB}`
  if (!/^\d+-\d+-[a-zA-Z0-9_-]+$/.test(scope) || !env.RUNNER_TEMP || !env.GITHUB_ENV)
    throw new Error("CI browser runner identity is unavailable")
  return {
    scope,
    name: `lyrashield-ci-browser-${scope}`,
    statePath: join(env.RUNNER_TEMP, `ci-browser-${scope}.json`),
  }
}

function packageDirectories() {
  const test = require.resolve("@playwright/test/package.json")
  const playwright = createRequire(test).resolve("playwright/package.json")
  const core = createRequire(playwright).resolve("playwright-core/package.json")
  for (const path of [test, playwright, core])
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from the validated CI identity, locked package resolution or guarded fixture output.
    if (JSON.parse(readFileSync(path, "utf8")).version !== BROWSER_VERSION)
      throw new Error("Update and qualify the CI browser image with the Playwright lockfile")
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from the validated CI identity, locked package resolution or guarded fixture output.
  return [realpathSync(dirname(playwright)), realpathSync(dirname(core))]
}

function verifyOwnedContainer(id, ctx, run) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("CI browser container identity unavailable")
  const [container] = JSON.parse(run("docker", ["inspect", id]))
  if (
    container.Id !== id ||
    container.Name !== `/${ctx.name}` ||
    container.Config.Labels?.[label] !== ctx.scope ||
    container.Config.Image !== BROWSER_IMAGE
  )
    throw new Error("Refusing to operate on an unowned CI browser container")
}

function findOwnedContainer(ctx, run) {
  const id = run("docker", [
    "ps",
    "--all",
    "--no-trunc",
    "--filter",
    `name=^/${ctx.name}$`,
    "--format",
    "{{.ID}}",
  ]).trim()
  if (id) verifyOwnedContainer(id, ctx, run)
  return id
}

function ownedState(env, run) {
  const ctx = context(env)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from the validated CI identity, locked package resolution or guarded fixture output.
  if (!existsSync(ctx.statePath)) return undefined
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from the validated CI identity, locked package resolution or guarded fixture output.
  const state = JSON.parse(readFileSync(ctx.statePath, "utf8"))
  if (state.name !== ctx.name || state.image !== BROWSER_IMAGE)
    throw new Error("CI browser state identity mismatch")
  if (
    typeof state.fontDir !== "string" ||
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from locked packages or the validated private CI font and trace directories.
    dirname(state.fontDir) !== realpathSync(env.RUNNER_TEMP) ||
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from locked packages or the validated private CI font and trace directories.
    !state.fontDir.startsWith(join(realpathSync(env.RUNNER_TEMP), `ci-fonts-${ctx.scope}-`))
  )
    throw new Error("CI font directory identity mismatch")
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Require the canonical private directory allocated by this job, never a substituted link.
  if (realpathSync(state.fontDir) !== state.fontDir) throw new Error("CI font directory is a link")
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from locked packages or the validated private CI font and trace directories.
  const marker = JSON.parse(readFileSync(join(state.fontDir, ".ci-owned.json"), "utf8"))
  if (marker.id !== state.id || marker.scope !== ctx.scope || marker.image !== BROWSER_IMAGE)
    throw new Error("Refusing to remove an unowned font directory")
  verifyOwnedContainer(state.id, ctx, run)
  return state
}

export function stopBrowser({ env = process.env, run = runCommand } = {}) {
  const ctx = context(env)
  const state = ownedState(env, run)
  const id = state?.id || findOwnedContainer(ctx, run)
  if (!id) return
  run("docker", ["rm", "--force", id])
  rmSync(join(env.RUNNER_TEMP, `ci-ffmpeg-${ctx.scope}`), { recursive: true, force: true })
  if (state) {
    rmSync(state.fontDir, { recursive: true, force: true })
    rmSync(ctx.statePath)
  }
}

export async function startBrowser({
  env = process.env,
  run = runCommand,
  packages = packageDirectories,
  writeState = writeFileSync,
} = {}) {
  const ctx = context(env)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from the validated CI identity, locked package resolution or guarded fixture output.
  if (existsSync(ctx.statePath)) throw new Error("CI browser state already exists")
  const dirs = packages()
  run("docker", ["pull", "--platform", "linux/amd64", BROWSER_IMAGE], { timeout: 12 * 60_000 })
  const [image] = JSON.parse(run("docker", ["image", "inspect", BROWSER_IMAGE]))
  if (
    image.Architecture !== "amd64" ||
    image.Os !== "linux" ||
    !image.RepoDigests?.includes(BROWSER_IMAGE)
  )
    throw new Error("CI browser image identity mismatch")
  let id
  let fontDir
  const state = (containerId) =>
    JSON.stringify({ id: containerId, name: ctx.name, image: BROWSER_IMAGE, fontDir })
  try {
    id = run(
      "docker",
      [
        "run",
        "--detach",
        "--name",
        ctx.name,
        "--label",
        `${label}=${ctx.scope}`,
        "--platform",
        "linux/amd64",
        "--read-only",
        "--user",
        "1000:1000",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--shm-size",
        "512m",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=512m",
        "--network",
        "none",
        "--env",
        "HOME=/tmp",
        BROWSER_IMAGE,
        "node",
        "-e",
        "setInterval(() => {}, 1000)",
      ],
      { timeout: 60_000 }
    ).trim()
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("CI browser container identity unavailable")
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from locked packages or the validated private CI font and trace directories.
    fontDir = realpathSync(mkdtempSync(join(env.RUNNER_TEMP, `ci-fonts-${ctx.scope}-`)))
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from locked packages or the validated private CI font and trace directories.
    writeFileSync(
      join(fontDir, ".ci-owned.json"),
      JSON.stringify({ id, scope: ctx.scope, image: BROWSER_IMAGE }),
      { mode: 0o600, flag: "wx" }
    )
    writeState(ctx.statePath, state(id), {
      mode: 0o600,
      flag: "wx",
    })
    run("docker", ["exec", id, "mkdir", "-p", "/tmp/ci-browser"])
    for (const [source, destination] of [
      ["ci-browser-container.mjs", "container.mjs"],
      ["ci-browser-fonts.mjs", "fonts.mjs"],
    ])
      run(
        "docker",
        [
          "exec",
          "--interactive",
          id,
          "node",
          "-e",
          `require("fs").writeFileSync("/tmp/ci-browser/${destination}", require("fs").readFileSync(0))`,
        ],
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from locked packages or the validated private CI font and trace directories.
        { input: readFileSync(new URL(source, import.meta.url)) }
      )
    const proof = run("docker", ["exec", id, "node", "/tmp/ci-browser/container.mjs", "verify"], {
      timeout: 120_000,
    }).trim()
    if (proof) console.log(proof)
    const archive = run(
      "docker",
      ["exec", id, "node", "/tmp/ci-browser/container.mjs", "font-archive"],
      { binary: true, timeout: 120_000, outputLimit: FONT_COMPRESSED_LIMIT }
    )
    const manifest = unpackFonts(archive, join(fontDir, "fonts"))
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from locked packages or the validated private CI font and trace directories.
    writeFileSync(join(fontDir, "manifest.json"), JSON.stringify(manifest), {
      mode: 0o600,
      flag: "wx",
    })
    const config = join(fontDir, "fonts.conf")
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from locked packages or the validated private CI font and trace directories.
    mkdirSync(join(fontDir, "cache"), { mode: 0o700 })
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from locked packages or the validated private CI font and trace directories.
    writeFileSync(config, fontconfigOverlay(join(fontDir, "fonts"), join(fontDir, "cache")), {
      mode: 0o600,
      flag: "wx",
    })
    // Download only the locked browser binaries. Apt validation is independently
    // enforced below through font assets, ldd and native runtime launches.
    run("node", [join(dirs[0], "cli.js"), "install", "chromium"], { timeout: 12 * 60_000 })
    const hostProof = run(
      "node",
      [fileURLToPath(new URL("ci-browser-host.mjs", import.meta.url)), fontDir],
      { timeout: 180_000, env: { ...env, FONTCONFIG_FILE: config }, hostDiagnostic: true }
    ).trim()
    if (hostProof) console.log(hostProof)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from locked packages or the validated private CI font and trace directories.
    appendFileSync(env.GITHUB_ENV, `FONTCONFIG_FILE=${config}\n`)
  } catch (error) {
    // A failed Docker acknowledgement may still have created the container.
    // Resolve only the immutable preselected name, then verify its full ID,
    // label and pinned image. State publication cannot redirect cleanup.
    const cleanupId = /^[a-f0-9]{64}$/.test(id ?? "") ? id : findOwnedContainer(ctx, run)
    if (cleanupId) {
      verifyOwnedContainer(cleanupId, ctx, run)
      run("docker", ["rm", "--force", cleanupId])
    }
    // Preserve a substituted state file. Only the bytes published for this
    // acknowledged container can be removed after startup fails.
    if (fontDir) rmSync(fontDir, { recursive: true, force: true })
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from locked packages or the validated private CI font and trace directories.
    if (id && existsSync(ctx.statePath) && readFileSync(ctx.statePath, "utf8") === state(id))
      rmSync(ctx.statePath)
    throw error
  }
}

export function syntheticFixture(args, repoRoot = root) {
  const output = resolve(args.at(-1) ?? "")
  for (const [variant, contract] of Object.entries(MOTION_VARIANTS)) {
    const expected = [
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
    ]
    const expectedOutput = resolve(
      repoRoot,
      `apps/marketing/dist/client/media-local/assurance-world/v${MOTION_VERSION}/local/${variant}/assurance-world.mp4`
    )
    if (output === expectedOutput && JSON.stringify(args.slice(0, -1)) === JSON.stringify(expected))
      return {
        output,
        width: contract.width,
        height: contract.height,
        gop: contract.gop,
        fps: MOTION_FPS,
        duration: MOTION_DURATION,
      }
  }
  throw new Error("CI FFmpeg fallback accepts only the current synthetic motion fixture command")
}

export function prepareFfmpeg({ env = process.env, run = runCommand } = {}) {
  context(env)
  try {
    run(
      "ffmpeg",
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=0x344c64:s=320x180:r=24:d=1",
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-f",
        "null",
        "-",
      ],
      { timeout: 60_000 }
    )
    console.log("Validated host FFmpeg lavfi and libx264")
    return
  } catch {
    if (!ownedState(env, run))
      throw new Error("CI FFmpeg fallback requires the qualified browser container")
  }
  if (!env.GITHUB_PATH) throw new Error("GitHub PATH publication is unavailable")
  const dir = join(env.RUNNER_TEMP, `ci-ffmpeg-${context(env).scope}`)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from the validated CI identity, locked package resolution or guarded fixture output.
  mkdirSync(dir, { mode: 0o700 })
  const helper = fileURLToPath(import.meta.url)
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from the validated CI identity, locked package resolution or guarded fixture output.
  writeFileSync(join(dir, "ffmpeg"), `#!/bin/sh\nexec node ${quote(helper)} ffmpeg "$@"\n`, {
    mode: 0o700,
  })
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from the validated CI identity, locked package resolution or guarded fixture output.
  appendFileSync(env.GITHUB_PATH, `${dir}\n`)
  console.log("Using qualified container FFmpeg for synthetic motion fixtures")
}

export function transcodeFixture(
  args,
  { env = process.env, run = runCommand, repoRoot = root } = {}
) {
  const fixture = syntheticFixture(args, repoRoot)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from the validated CI identity, locked package resolution or guarded fixture output.
  if (realpathSync(dirname(fixture.output)) !== dirname(fixture.output))
    throw new Error("CI fixture output must not traverse symlinks")
  const state = ownedState(env, run)
  if (!state) throw new Error("Qualified CI browser container is unavailable")
  const { output, ...parameters } = fixture
  const bytes = run(
    "docker",
    [
      "exec",
      state.id,
      "node",
      "/tmp/ci-browser/container.mjs",
      "ffmpeg",
      JSON.stringify(parameters),
    ],
    { timeout: 120_000, binary: true }
  )
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 12 ||
    bytes.length > maxBuffer ||
    bytes.toString("ascii", 4, 8) !== "ftyp"
  )
    throw new Error("CI FFmpeg did not return a bounded MP4 fixture")
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from the validated CI identity, locked package resolution or guarded fixture output.
  writeFileSync(output, bytes, { flag: "wx" })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2]
    if (command === "start") await startBrowser()
    else if (command === "stop") stopBrowser()
    else if (command === "prepare-ffmpeg") prepareFfmpeg()
    else if (command === "ffmpeg") transcodeFixture(process.argv.slice(3))
    else throw new Error("Unknown CI browser command")
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
