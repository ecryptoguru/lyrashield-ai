#!/usr/bin/env node
/**
 * WebMCP runtime checker — opt-in runtime checks of customer-controlled
 * WebMCP fixture pages inside an ephemeral browser profile.
 *
 *   node scripts/webmcp-runtime-check.mjs \
 *     --fixture-dir e2e/webmcp-runtime/fixtures \
 *     [--target /page.html | --target https://declared.example/page]... \
 *     [--allow-origin <origin>]... \
 *     [--active-tool <name> [--active-input <json>] [--active-abort-ms N]]... \
 *     [--timeout-ms N] [--json out.json] [--markdown out.md]
 *
 * What it does
 * ------------
 * - Serves ONLY files under --fixture-dir on an ephemeral 127.0.0.1 port
 *   (path-traversal safe, GET/HEAD only). That loopback origin is the only
 *   loopback origin ever allowed — --target/--allow-origin cannot declare
 *   other loopback endpoints.
 * - Launches an ephemeral Chromium profile (@playwright/test's chromium; honor
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH for a native-capable build). No browser
 *   binaries are downloaded.
 * - Enforces an exact-origin allowlist on every request/redirect (route
 *   interception) and on websockets; undeclared attempts are blocked + recorded.
 * - Passive mode (default): load each fixture, observe document.modelContext,
 *   enumerate registered tools WITHOUT executing anything mutating.
 * - Active mode: ONLY tool names given via --active-tool run, through the
 *   fixture's __invokeTool hook, and only when the native API is present.
 *   readOnlyHint alone never proves a tool safe to execute.
 *
 * Receipt semantics (lyrashield-webmcp-runtime/1)
 * ---------------------------------------------
 * - PASS attests a check that actually executed: for native-WebMCP checks
 *   that means the real document.modelContext API on a native-capable browser.
 * - INCONCLUSIVE records a check that could not produce evidence — e.g. the
 *   native WebMCP API is absent in the browser (stock Chromium today). A JS
 *   shim never produces a native-browser PASS.
 * - FAIL records an observed violation (undeclared-origin request attempted,
 *   a tool executed during passive observation, a page that failed to load).
 * - NOT_APPLICABLE records a check that does not apply to the fixture.
 *
 * Exit codes: 0 = no FAIL (PASS/INCONCLUSIVE mix is a successful run);
 * 1 = at least one FAIL check or a runner-internal failure after start;
 * 2 = argument/usage error.
 *
 * The receipt covers exactly the named checks, browser, fixture content, and
 * invocation — it is not proof of universal safety. A receipt supplied by a
 * customer is untrusted external evidence until independently reproduced.
 */

import http from "node:http"
import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export const DEFAULT_TIMEOUT_MS = 60_000
const NAV_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 600_000
const FIXTURE_EXTENSIONS = new Set([".html", ".htm"])

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export class CliError extends Error {
  constructor(message) {
    super(message)
    this.name = "CliError"
  }
}

const USAGE = `Usage: node scripts/webmcp-runtime-check.mjs \\
  --fixture-dir <dir> [--target /page.html | --target https://host/page]... \\
  [--allow-origin <origin>]... \\
  [--active-tool <name> [--active-input <json>] [--active-abort-ms N]]... \\
  [--timeout-ms N] [--json out.json] [--markdown out.md]`

export function parseArgs(argv) {
  const args = {
    fixtureDir: null,
    targets: [],
    allowOrigins: [],
    activeTools: [],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    jsonPath: null,
    markdownPath: null,
    help: false,
  }
  const needValue = (flag, i) => {
    if (i + 1 >= argv.length) throw new CliError(`${flag} requires a value`)
    return argv[i + 1]
  }
  const lastActiveTool = () => {
    const tool = args.activeTools[args.activeTools.length - 1]
    if (!tool) throw new CliError("flag must follow an --active-tool")
    return tool
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case "--help":
      case "-h":
        args.help = true
        break
      case "--fixture-dir":
        args.fixtureDir = needValue(arg, i)
        i++
        break
      case "--target":
        args.targets.push(needValue(arg, i))
        i++
        break
      case "--allow-origin":
        args.allowOrigins.push(needValue(arg, i))
        i++
        break
      case "--active-tool":
        args.activeTools.push({ name: needValue(arg, i), input: {}, abortAfterMs: undefined })
        i++
        break
      case "--active-input": {
        const raw = needValue(arg, i)
        let input
        try {
          input = JSON.parse(raw)
        } catch {
          throw new CliError(`--active-input must be valid JSON, got ${JSON.stringify(raw)}`)
        }
        if (input === null || typeof input !== "object" || Array.isArray(input)) {
          throw new CliError("--active-input must be a JSON object")
        }
        lastActiveTool().input = input
        i++
        break
      }
      case "--active-abort-ms": {
        const raw = needValue(arg, i)
        const value = Number(raw)
        if (!Number.isFinite(value) || value < 0 || value > MAX_TIMEOUT_MS) {
          throw new CliError(`--active-abort-ms must be 0-${MAX_TIMEOUT_MS}`)
        }
        lastActiveTool().abortAfterMs = value
        i++
        break
      }
      case "--timeout-ms": {
        const raw = needValue(arg, i)
        const value = Number(raw)
        if (!Number.isFinite(value) || value < 1_000 || value > MAX_TIMEOUT_MS) {
          throw new CliError(`--timeout-ms must be 1000-${MAX_TIMEOUT_MS}`)
        }
        args.timeoutMs = value
        i++
        break
      }
      case "--json":
        args.jsonPath = needValue(arg, i)
        i++
        break
      case "--markdown":
        args.markdownPath = needValue(arg, i)
        i++
        break
      default:
        if (arg.startsWith("--")) throw new CliError(`unknown flag ${arg}`)
        throw new CliError(`unexpected positional argument ${JSON.stringify(arg)}`)
    }
  }

  if (args.help) return args
  if (!args.fixtureDir && args.targets.length === 0) {
    throw new CliError("provide --fixture-dir and/or --target\n\n" + USAGE)
  }
  const names = new Set()
  for (const tool of args.activeTools) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)) {
      throw new CliError(`--active-tool name ${JSON.stringify(tool.name)} is not a valid tool name`)
    }
    if (names.has(tool.name)) {
      throw new CliError(`--active-tool ${JSON.stringify(tool.name)} given twice`)
    }
    names.add(tool.name)
  }
  return args
}

// ---------------------------------------------------------------------------
// Small helpers (pure, unit-testable)
// ---------------------------------------------------------------------------

/** Check-id vocabulary: per-fixture ids carry the fixture basename. */
export function checkId(base, fixtureName) {
  return `${base}:${fixtureName}`
}

function truncate(text, max = 160) {
  const value = String(text)
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".htm", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".map", "application/json; charset=utf-8"],
])

/**
 * Static fixture server: serves only regular files that resolve inside the
 * declared fixture root (path-traversal and symlink-escape safe), GET/HEAD
 * only, on an ephemeral 127.0.0.1 port. The returned origin is the single
 * loopback origin the request allowlist ever permits.
 */
export async function startFixtureServer(fixtureDir) {
  const root = await fs.realpath(fixtureDir)
  const stat = await fs.stat(root)
  if (!stat.isDirectory()) throw new CliError(`--fixture-dir ${fixtureDir} is not a directory`)

  const server = http.createServer((req, res) => {
    const close = (code, text) => {
      res.writeHead(code, { "content-type": "text/plain; charset=utf-8" })
      res.end(text)
    }
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        close(405, "method not allowed")
        return
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      const pathname = decodeURIComponent(url.pathname)
      if (pathname.includes("\0")) {
        close(400, "bad path")
        return
      }
      const candidate = path.resolve(root, pathname.replace(/^\/+/, ""))
      if (candidate !== root && !candidate.startsWith(root + path.sep)) {
        close(404, "not found")
        return
      }
      void (async () => {
        // Resolve symlinks so an escaping link cannot leave the fixture root.
        const real = await fs.realpath(candidate).catch(() => null)
        if (!real || (real !== root && !real.startsWith(root + path.sep))) {
          close(404, "not found")
          return
        }
        const info = await fs.stat(real).catch(() => null)
        if (!info || !info.isFile()) {
          close(404, "not found")
          return
        }
        res.writeHead(200, {
          "content-type":
            CONTENT_TYPES.get(path.extname(real).toLowerCase()) ?? "application/octet-stream",
          "content-length": info.size,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        })
        if (req.method === "HEAD") {
          res.end()
          return
        }
        res.end(await fs.readFile(real))
      })()
    } catch {
      close(400, "bad request")
    }
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const { port } = server.address()
  return {
    root,
    origin: `http://127.0.0.1:${port}`,
    urlFor: (fixturePath) => `http://127.0.0.1:${port}/${fixturePath.replace(/^\/+/, "")}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Enumerate fixture pages (top-level *.html/*.htm) under a fixture dir. */
export async function listFixturePages(fixtureDir) {
  const entries = await fs.readdir(fixtureDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && FIXTURE_EXTENSIONS.has(path.extname(entry.name)))
    .map((entry) => entry.name)
    .sort()
}

/**
 * Resolve an absolute --target URL. The origin must be sanitizable and
 * non-loopback: loopback targets exist only through the runner-owned fixture
 * server (fixture-relative "--target /x.html" values are resolved elsewhere).
 * The full URL (path included) is used for navigation; only its canonical
 * origin is stored or allowlisted.
 */
export function resolveAbsoluteTarget(raw, sanitizeOrigin) {
  let origin
  try {
    origin = sanitizeOrigin(raw, { allowLoopback: false })
  } catch (error) {
    throw new CliError(
      `--target ${JSON.stringify(raw)} rejected: ${error.message}. ` +
        "Loopback targets must be served via --fixture-dir."
    )
  }
  return { url: raw, origin }
}

/**
 * Validate an --allow-origin entry. Loopback is never declarable: the only
 * loopback origin the runner permits is the ephemeral fixture server it owns.
 */
export function sanitizeAllowOrigin(raw, sanitizeOrigin) {
  try {
    return sanitizeOrigin(raw, { allowAnyOriginSchemes: true, allowLoopback: false })
  } catch (error) {
    throw new CliError(
      `--allow-origin ${JSON.stringify(raw)} rejected: ${error.message} ` +
        "(loopback is never declarable)"
    )
  }
}

/** Deterministic sha256 over the fixture set: sorted relpath + NUL + bytes. */
export async function checksumFixtureSet(fixtureRoot) {
  const files = []
  const walk = async (dir, prefix) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel)
      else if (entry.isFile()) files.push(rel)
    }
  }
  await walk(fixtureRoot, "")
  files.sort()
  const hash = crypto.createHash("sha256")
  for (const rel of files) {
    hash.update(rel)
    hash.update("\0")
    hash.update(await fs.readFile(path.join(fixtureRoot, rel)))
    hash.update("\0")
  }
  return { digest: hash.digest("hex"), fileCount: files.length }
}

function gitRevision(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim()
  } catch {
    return undefined
  }
}

export function renderMarkdown(receipt, summary) {
  const lines = [
    "# WebMCP runtime-check receipt",
    "",
    `- run: \`${receipt.runId}\` at ${receipt.checkedAt}`,
    `- browser: ${receipt.browser.name} ${receipt.browser.version} (nativeApiAvailable: ${receipt.browser.nativeApiAvailable})`,
    `- target: ${receipt.target.origin}` +
      (receipt.target.revision ? ` rev ${receipt.target.revision}` : "") +
      (receipt.target.contentChecksum ? ` sha256:${receipt.target.contentChecksum}` : ""),
    `- overall: **${summary.overall}** — ${summary.counts.PASS} PASS, ${summary.counts.FAIL} FAIL, ` +
      `${summary.counts.INCONCLUSIVE} INCONCLUSIVE, ${summary.counts.NOT_APPLICABLE} NOT_APPLICABLE`,
    "",
    "| check | state | summary |",
    "| --- | --- | --- |",
  ]
  for (const check of receipt.checks) {
    lines.push(`| \`${check.id}\` | ${check.state} | ${check.summary.replace(/\|/g, "\\|")} |`)
  }
  if (receipt.limits.timedOut || receipt.limits.skipped.length > 0) {
    lines.push(
      "",
      `limits: timedOut=${receipt.limits.timedOut}` +
        (receipt.limits.skipped.length ? ` skipped=${receipt.limits.skipped.join(", ")}` : "")
    )
  }
  lines.push("")
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url))
const CONTRACT_URL = new URL(
  "../packages/security/src/webmcp/runtime-receipt.ts",
  import.meta.url
)

async function loadContract() {
  // Node ≥24 strips types natively; zod resolves through packages/security.
  const contract = await import(CONTRACT_URL.href)
  globalThis.__webmcpContract = contract
  return contract
}

function allowedOriginFor(url, sanitizeOrigin) {
  try {
    const origin = new URL(url).origin
    if (origin === "null") return null
    // Canonical form check only — scheme already constrained by the browser.
    return sanitizeOrigin(origin, { allowLoopback: true, allowAnyOriginSchemes: true })
  } catch {
    return null
  }
}

async function runChecks(args, contract) {
  const {
    sanitizeOrigin,
    createRuntimeReceipt,
    appendRuntimeCheck,
    recordRuntimeLimit,
    finalizeRuntimeReceipt,
    summarizeRuntimeReceipt,
    WEBMCP_RUNTIME_CHECK_IDS: IDS,
  } = contract

  const fixture = args.fixtureDir ? await startFixtureServer(args.fixtureDir) : null
  const startedAt = Date.now()
  const deadline = startedAt + args.timeoutMs
  let context = null
  let userDataDir = null

  try {
    // ---- declared-origin allowlist ------------------------------------
    const allowedOrigins = new Set()
    if (fixture) allowedOrigins.add(fixture.origin) // the ONLY loopback exception
    for (const raw of args.allowOrigins) {
      allowedOrigins.add(sanitizeAllowOrigin(raw, sanitizeOrigin))
    }

    // ---- targets -------------------------------------------------------
    const targets = []
    const fixturePages = fixture ? await listFixturePages(fixture.root) : []
    if (fixture && args.targets.length === 0) {
      for (const name of fixturePages) targets.push({ url: fixture.urlFor(name), name })
    }
    for (const raw of args.targets) {
      if (/^https?:\/\//i.test(raw)) {
        const resolved = resolveAbsoluteTarget(raw, sanitizeOrigin)
        allowedOrigins.add(resolved.origin) // explicit targets are declared
        targets.push({ url: resolved.url, name: resolved.url })
      } else {
        if (!fixture) throw new CliError(`target ${JSON.stringify(raw)} requires --fixture-dir`)
        const rel = raw.replace(/^\/+/, "")
        const candidate = path.resolve(fixture.root, rel)
        if (!candidate.startsWith(fixture.root + path.sep)) {
          throw new CliError(`target ${JSON.stringify(raw)} escapes the fixture directory`)
        }
        targets.push({ url: fixture.urlFor(rel), name: rel })
      }
    }
    if (targets.length === 0) {
      throw new CliError("no targets: fixture directory contains no *.html pages")
    }

    // ---- browser -------------------------------------------------------
    const { chromium } = await import("@playwright/test")
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "webmcp-runtime-profile-"))
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined
    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        headless: true,
        executablePath,
      })
    } catch (error) {
      throw new Error(
        `failed to launch Chromium (${executablePath ?? "playwright-managed"}): ${error.message}\n` +
          "No browser binaries are downloaded by this tool; install @playwright/test browsers " +
          "or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH."
      )
    }

    const browserVersion = (() => {
      try {
        return context.browser()?.version() ?? "unknown"
      } catch {
        return "unknown"
      }
    })()

    // ---- receipt skeleton -----------------------------------------------
    let checksum
    if (fixture) checksum = await checksumFixtureSet(fixture.root)
    const revision = gitRevision(REPO_ROOT)
    const receipt = createRuntimeReceipt({
      browser: { name: "chromium", version: browserVersion, nativeApiAvailable: false },
      target: {
        url: fixture ? fixture.origin : targets[0].url,
        revision,
        contentChecksum: checksum?.digest,
      },
    })

    const activeToolsMatched = new Set()

    const record = (id, state, summary) =>
      appendRuntimeCheck(receipt, { id, state, method: "native-browser", summary })

    for (const target of targets) {
      if (Date.now() > deadline) {
        recordRuntimeLimit(receipt, { timedOut: true, skip: `target:${target.name}` })
        continue
      }
      const fixtureName = target.name
      const blocked = [] // {origin, resourceType, kind}
      let allowedRequestCount = 0
      const page = await context.newPage()
      page.setDefaultTimeout(NAV_TIMEOUT_MS)
      await page.route("**/*", (route) => {
        const request = route.request()
        // Non-network schemes never dispatch to an origin.
        if (/^(data|blob|about|chrome|devtools):/i.test(request.url())) {
          return route.continue().catch(() => {})
        }
        const origin = allowedOriginFor(request.url(), sanitizeOrigin)
        if (origin === null || !allowedOrigins.has(origin)) {
          blocked.push({
            origin: origin ?? "unparseable",
            resourceType: request.resourceType(),
          })
          return route.abort("blockedbyclient").catch(() => {})
        }
        allowedRequestCount += 1
        return route.continue().catch(() => {})
      })
      page.on("websocket", (ws) => {
        const origin = allowedOriginFor(ws.url(), sanitizeOrigin)
        if (origin === null || !allowedOrigins.has(origin)) {
          blocked.push({ origin: origin ?? "unparseable", resourceType: "websocket" })
          try {
            ws.close()
          } catch {
            /* already closed */
          }
        }
      })

      const remaining = () => deadline - Date.now()
      const navTimeout = Math.max(500, Math.min(NAV_TIMEOUT_MS, remaining()))

      // 1. fixture load
      let loaded = false
      try {
        await page.goto(target.url, { waitUntil: "load", timeout: navTimeout })
        loaded = true
        record(checkId(IDS.fixtureLoad, fixtureName), "PASS", `loaded ${fixtureName}`)
      } catch (error) {
        record(
          checkId(IDS.fixtureLoad, fixtureName),
          "FAIL",
          `failed to load ${fixtureName}: ${truncate(error.message)}`
        )
      }

      // settled a moment for late subresource attempts
      if (loaded) await page.waitForTimeout(300)

      // 2. declared origins
      if (blocked.length === 0) {
        record(
          checkId(IDS.declaredOrigins, fixtureName),
          "PASS",
          `${allowedRequestCount} request(s) stayed within declared origins`
        )
      } else {
        const origins = [...new Set(blocked.map((b) => b.origin))]
        record(
          checkId(IDS.declaredOrigins, fixtureName),
          "FAIL",
          `${blocked.length} request(s) to undeclared origins were attempted and blocked ` +
            `(${origins.join(", ")}); ${allowedRequestCount} request(s) stayed within declared origins`
        )
      }

      // 3. native API presence
      let nativeApi = false
      if (loaded) {
        nativeApi = await page
          .evaluate(() => typeof document !== "undefined" && Boolean(document.modelContext))
          .catch(() => false)
      }
      if (nativeApi) {
        record(
          checkId(IDS.nativeApi, fixtureName),
          "PASS",
          `document.modelContext is present in chromium ${browserVersion}`
        )
      } else {
        record(
          checkId(IDS.nativeApi, fixtureName),
          "INCONCLUSIVE",
          `native WebMCP API unavailable in chromium ${browserVersion}`
        )
      }
      receipt.browser.nativeApiAvailable ||= nativeApi

      // 4. tool enumeration (never executes anything)
      let enumerated = []
      if (!loaded) {
        recordRuntimeLimit(receipt, { skip: checkId(IDS.toolEnumeration, fixtureName) })
      } else if (!nativeApi) {
        record(
          checkId(IDS.toolEnumeration, fixtureName),
          "INCONCLUSIVE",
          `native WebMCP API unavailable in chromium ${browserVersion}; ` +
            `tool surface could not be enumerated`
        )
      } else {
        try {
          enumerated = await page.evaluate(async () => {
            const tools = await document.modelContext.getTools()
            return tools.map((tool) => ({
              name: String(tool.name ?? ""),
              title: String(tool.title ?? ""),
              readOnly: tool.annotations?.readOnlyHint === true,
            }))
          })
          const names = enumerated.map((t) => t.name).filter(Boolean)
          record(
            checkId(IDS.toolEnumeration, fixtureName),
            "PASS",
            `${names.length} tool(s) enumerated without execution` +
              (names.length ? `: ${names.join(", ")}` : "")
          )
        } catch (error) {
          record(
            checkId(IDS.toolEnumeration, fixtureName),
            "INCONCLUSIVE",
            `getTools() failed: ${truncate(error.message)}`
          )
        }
      }

      // 5. passive no-execution (instrumentation must stay empty)
      if (loaded) {
        const instrumentation = await page
          .evaluate(() => ({
            instrumented: Array.isArray(window.__toolCalls),
            calls: Array.isArray(window.__toolCalls) ? window.__toolCalls.length : 0,
            hookPresent: typeof window.__invokeTool === "function",
            declaredTools: Array.isArray(window.__webmcpFixture?.registration)
              ? window.__webmcpFixture.registration.map((r) => String(r.name ?? ""))
              : [],
          }))
          .catch(() => null)
        if (instrumentation === null) {
          record(
            checkId(IDS.passiveNoExecution, fixtureName),
            "INCONCLUSIVE",
            "page instrumentation could not be read"
          )
        } else if (!instrumentation.instrumented) {
          record(
            checkId(IDS.passiveNoExecution, fixtureName),
            "NOT_APPLICABLE",
            "fixture does not instrument window.__toolCalls"
          )
        } else if (instrumentation.calls === 0) {
          record(
            checkId(IDS.passiveNoExecution, fixtureName),
            "PASS",
            "no tool executed during passive observation"
          )
        } else {
          record(
            checkId(IDS.passiveNoExecution, fixtureName),
            "FAIL",
            `${instrumentation.calls} tool call(s) observed during passive mode — passive must never execute`
          )
        }

        // 6. active-mode executions (explicitly allowlisted tools only)
        const declaredTools = instrumentation?.declaredTools ?? []
        const hookPresent = instrumentation?.hookPresent === true
        for (const activeTool of args.activeTools) {
          const toolCheckId = `${IDS.toolExecution}:${fixtureName}:${activeTool.name}`
          if (!declaredTools.includes(activeTool.name)) {
            record(
              toolCheckId,
              "NOT_APPLICABLE",
              `tool ${activeTool.name} is not registered by ${fixtureName}`
            )
            continue
          }
          activeToolsMatched.add(activeTool.name)
          if (!nativeApi) {
            record(
              toolCheckId,
              "INCONCLUSIVE",
              `native WebMCP API unavailable in chromium ${browserVersion}; ` +
                `fixture-hook execution is not native evidence — ${activeTool.name} was not executed`
            )
            continue
          }
          if (!hookPresent) {
            record(
              toolCheckId,
              "INCONCLUSIVE",
              `fixture does not expose __invokeTool; native dispatch is not callable from page JS`
            )
            continue
          }
          const before = await page
            .evaluate(() => (Array.isArray(window.__toolCalls) ? window.__toolCalls.length : 0))
            .catch(() => 0)
          const result = await page
            .evaluate(
              ({ name, input, abortAfterMs }) =>
                window.__invokeTool(name, input, { abortAfterMs }),
              {
                name: activeTool.name,
                input: activeTool.input,
                abortAfterMs: activeTool.abortAfterMs,
              }
            )
            .catch((error) => ({ called: false, error: truncate(error.message) }))
          const after = await page
            .evaluate(() => (Array.isArray(window.__toolCalls) ? window.__toolCalls.length : 0))
            .catch(() => before)
          const observed = after > before
          if (!result.called) {
            record(
              toolCheckId,
              "FAIL",
              `allowlisted tool ${activeTool.name} could not be invoked: ${truncate(result.error)}`
            )
          } else if (!observed) {
            record(
              toolCheckId,
              "FAIL",
              `tool ${activeTool.name} invoked but instrumentation recorded no call`
            )
          } else if (result.ok) {
            record(
              toolCheckId,
              "PASS",
              `executed ${activeTool.name} via fixture hook; effect observed in instrumentation ` +
                `(native dispatch is not callable from page JS)`
            )
          } else if (result.errorName === "AbortError" && activeTool.abortAfterMs !== undefined) {
            record(
              toolCheckId,
              "PASS",
              `cancel propagated to ${activeTool.name} via AbortSignal (abortAfterMs=${activeTool.abortAfterMs})`
            )
          } else {
            record(
              toolCheckId,
              "PASS",
              `executed ${activeTool.name}; handler rejected/errored as observed: ${truncate(result.error)}`
            )
          }
        }
      } else {
        recordRuntimeLimit(receipt, { skip: checkId(IDS.passiveNoExecution, fixtureName) })
        for (const activeTool of args.activeTools) {
          recordRuntimeLimit(receipt, {
            skip: `${IDS.toolExecution}:${fixtureName}:${activeTool.name}`,
          })
        }
      }

      await page.close().catch(() => {})
    }

    // allowlisted tools that no target ever registered
    for (const activeTool of args.activeTools) {
      if (!activeToolsMatched.has(activeTool.name)) {
        record(
          `${IDS.toolExecution}:${activeTool.name}`,
          "FAIL",
          `allowlisted tool ${activeTool.name} was never registered by any target`
        )
      }
    }

    return {
      receipt: finalizeRuntimeReceipt(receipt),
      fixture,
      summary: summarizeRuntimeReceipt(receipt),
    }
  } finally {
    if (context) await context.close().catch(() => {})
    if (userDataDir) await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {})
    if (fixture) await fixture.close()
  }
}

function printReport(receipt, summary) {
  for (const check of receipt.checks) {
    process.stdout.write(`${check.state.padEnd(14)} ${check.id} — ${check.summary}\n`)
  }
  process.stdout.write(
    `overall: ${summary.overall} (${summary.counts.PASS} PASS, ${summary.counts.FAIL} FAIL, ` +
      `${summary.counts.INCONCLUSIVE} INCONCLUSIVE, ${summary.counts.NOT_APPLICABLE} NOT_APPLICABLE)\n`
  )
  process.stdout.write(
    `browser: ${receipt.browser.name} ${receipt.browser.version}, ` +
      `nativeApiAvailable=${receipt.browser.nativeApiAvailable}\n`
  )
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(USAGE + "\n")
    return 0
  }
  const contract = await loadContract()
  // Prevalidate declarable inputs so usage errors exit 2 before any
  // server/browser work starts (they are re-validated inside runChecks).
  for (const raw of args.allowOrigins) sanitizeAllowOrigin(raw, contract.sanitizeOrigin)
  for (const raw of args.targets) {
    if (/^https?:\/\//i.test(raw)) resolveAbsoluteTarget(raw, contract.sanitizeOrigin)
  }
  const { receipt, summary } = await runChecks(args, contract)
  printReport(receipt, summary)
  if (args.jsonPath) {
    await fs.writeFile(args.jsonPath, JSON.stringify(receipt, null, 2) + "\n", "utf8")
    process.stdout.write(`receipt written to ${args.jsonPath}\n`)
  }
  if (args.markdownPath) {
    await fs.writeFile(args.markdownPath, renderMarkdown(receipt, summary), "utf8")
    process.stdout.write(`markdown written to ${args.markdownPath}\n`)
  }
  return summary.counts.FAIL > 0 ? 1 : 0
}

const invokedAsScript =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedAsScript) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      const cli = error instanceof CliError
      process.stderr.write(`${cli ? "error" : "fatal"}: ${error.message}\n`)
      if (cli) process.stderr.write(USAGE + "\n")
      process.exitCode = cli ? 2 : 1
    })
}
