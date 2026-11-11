import { spawnSync } from "node:child_process"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { createConnection } from "node:net"
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
export const BROWSER_PORT = 31777
const root = fileURLToPath(new URL("../..", import.meta.url))
const require = createRequire(import.meta.url)
const label = "lyrashield.ci-browser"
const maxBuffer = 32 * 1024 * 1024

function runCommand(command, args, { timeout = 30_000, binary = false } = {}) {
  const result = spawnSync(command, args, { encoding: binary ? null : "utf8", timeout, maxBuffer })
  if (result.error || result.status !== 0)
    throw new Error(`${command} ${args[0]} failed; exit ${result.status ?? "unavailable"}`)
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

async function waitForPort() {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const ready = await new Promise((resolveReady) => {
      const socket = createConnection({ host: "127.0.0.1", port: BROWSER_PORT })
      const done = (ready) => {
        socket.destroy()
        resolveReady(ready)
      }
      socket.setTimeout(1000, () => done(false))
      socket.once("error", () => done(false))
      socket.once("connect", () => done(true))
    })
    if (ready) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  throw new Error("CI browser loopback server did not become ready")
}

function ownedState(env, run) {
  const ctx = context(env)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from the validated CI identity, locked package resolution or guarded fixture output.
  if (!existsSync(ctx.statePath)) return undefined
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from the validated CI identity, locked package resolution or guarded fixture output.
  const state = JSON.parse(readFileSync(ctx.statePath, "utf8"))
  if (!/^[a-f0-9]{64}$/.test(state.id) || state.name !== ctx.name || state.image !== BROWSER_IMAGE)
    throw new Error("CI browser state identity mismatch")
  const [container] = JSON.parse(run("docker", ["inspect", state.id]))
  if (
    container.Id !== state.id ||
    container.Name !== `/${ctx.name}` ||
    container.Config.Labels?.[label] !== ctx.scope
  )
    throw new Error("Refusing to operate on an unowned CI browser container")
  return state
}

export function stopBrowser({ env = process.env, run = runCommand } = {}) {
  const state = ownedState(env, run)
  if (!state) return
  run("docker", ["rm", "--force", state.id])
  rmSync(join(env.RUNNER_TEMP, `ci-ffmpeg-${context(env).scope}`), { recursive: true, force: true })
  rmSync(context(env).statePath)
}

export async function startBrowser({
  env = process.env,
  run = runCommand,
  wait = waitForPort,
  packages = packageDirectories,
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
  const id = run(
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
      "host",
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
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from the validated CI identity, locked package resolution or guarded fixture output.
  writeFileSync(ctx.statePath, JSON.stringify({ id, name: ctx.name, image: BROWSER_IMAGE }), {
    mode: 0o600,
  })
  try {
    run("docker", [
      "exec",
      id,
      "mkdir",
      "-p",
      "/tmp/ci-browser/node_modules/playwright",
      "/tmp/ci-browser/node_modules/playwright-core",
    ])
    for (const [index, name] of ["playwright", "playwright-core"].entries())
      run("docker", ["cp", `${dirs[index]}/.`, `${id}:/tmp/ci-browser/node_modules/${name}`], {
        timeout: 60_000,
      })
    run("docker", [
      "cp",
      fileURLToPath(new URL("ci-browser-container.mjs", import.meta.url)),
      `${id}:/tmp/ci-browser/container.mjs`,
    ])
    console.log(
      run("docker", ["exec", id, "node", "/tmp/ci-browser/container.mjs", "verify"], {
        timeout: 120_000,
      }).trim()
    )
    // Only this disposable, unprivileged, mount-free loopback server permits
    // launch options. Playwright otherwise strips the native WebMCP test's args.
    run("docker", [
      "exec",
      "--detach",
      id,
      "node",
      "/tmp/ci-browser/node_modules/playwright/cli.js",
      "run-server",
      "--host",
      "127.0.0.1",
      "--port",
      String(BROWSER_PORT),
      "--max-clients",
      "24",
      "--unsafe",
    ])
    await wait()
    console.log(
      run("docker", ["exec", id, "node", "/tmp/ci-browser/container.mjs", "verify-server"], {
        timeout: 60_000,
      }).trim()
    )
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths come from the validated CI identity, locked package resolution or guarded fixture output.
    appendFileSync(env.GITHUB_ENV, `PW_TEST_CONNECT_WS_ENDPOINT=ws://127.0.0.1:${BROWSER_PORT}/\n`)
  } catch (error) {
    stopBrowser({ env, run })
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
