#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto"
import { resolve4 } from "node:dns/promises"
import { readFile, stat, writeFile } from "node:fs/promises"
import { BlockList } from "node:net"
import { chromium } from "@playwright/test"
import { parseWebMcpRuntimeReceipt } from "../packages/security/src/webmcp/runtime-receipt.ts"
import { startFixture } from "../e2e/webmcp-runtime/fixture.mjs"

const checkIds = ["NATIVE_API", "DISCOVERY", "SCHEMA_REJECTION", "OUTPUT_BOUND", "CANCELLATION", "CLEANUP", "CROSS_ORIGIN", "CONFIRMATION"]

export function exactLocalOrigin(input) {
  const url = new URL(input)
  if (url.origin !== input || url.username || url.password || url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("Expected exact http://127.0.0.1:<port> origin; no path, query, credentials, or DNS name")
  }
  return url.origin
}

const disallowedIps = new BlockList()
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) disallowedIps.addSubnet(address, prefix)

export function exactRemoteOrigin(input) {
  const url = new URL(input)
  if (url.origin !== input || url.protocol !== "https:" || url.username || url.password || !/^[a-z0-9.-]+$/.test(url.hostname) || !url.hostname.includes(".") || !/[a-z]/.test(url.hostname)) {
    throw new Error("Expected an exact HTTPS DNS origin without path, query, or credentials")
  }
  return url.origin
}

export async function pinRemoteOrigin(origin, resolve = resolve4) {
  const addresses = await resolve(new URL(origin).hostname)
  if (!addresses.length || addresses.some((address) => disallowedIps.check(address, "ipv4"))) {
    throw new Error("Staging origin DNS did not resolve exclusively to public IPv4 addresses")
  }
  return addresses[0]
}

export function requestAllowed(input, allowedOrigins) {
  const url = new URL(input)
  return ["http:", "https:"].includes(url.protocol) && allowedOrigins.has(url.origin)
}

export function parseOptions(argv) {
  const options = { activeTools: [] }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === "--fixture") options.fixture = true
    else if (flag === "--owned-staging") options.ownedStaging = true
    else if (["--origin", "--allow-origin", "--browser", "--output", "--revision", "--checksum", "--active-tool", "--input-file"].includes(flag)) {
      const value = argv[++i]
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`)
      if (flag === "--active-tool") options.activeTools.push(value)
      else options[{ "--origin": "origin", "--allow-origin": "allowOrigin", "--browser": "browser", "--output": "output", "--revision": "revision", "--checksum": "checksum", "--input-file": "inputFile" }[flag]] = value
    } else throw new Error(`Unknown option: ${flag}`)
  }
  if (options.fixture === Boolean(options.origin)) throw new Error("Choose exactly one of --fixture or --origin")
  if (!options.fixture) {
    if (options.ownedStaging || options.allowOrigin) {
      if (!options.ownedStaging || !options.allowOrigin || options.allowOrigin !== options.origin) {
        throw new Error("Owned staging requires matching --origin and --allow-origin plus --owned-staging")
      }
      options.origin = exactRemoteOrigin(options.origin)
    } else options.origin = exactLocalOrigin(options.origin)
  } else if (options.ownedStaging || options.allowOrigin) throw new Error("Fixture mode cannot use staging options")
  if (options.activeTools.length && (!options.inputFile || options.fixture)) throw new Error("Active tools require --input-file on an owned origin")
  if (options.inputFile && !options.activeTools.length) throw new Error("--input-file requires --active-tool")
  if (options.activeTools.length > 10 || options.activeTools.some((name) => !/^[a-zA-Z0-9_-]{1,80}$/.test(name))) throw new Error("Choose at most ten bounded tool names")
  if (!options.output) throw new Error("--output is required")
  return options
}

function check(id, state, summary) { return { id, state, method: "native-browser", summary } }

export async function run(options, launch = chromium.launch.bind(chromium)) {
  if (options.ownedStaging && options.allowOrigin !== options.origin) throw new Error("Staging origin must match the exact allowlist")
  const fixture = options.fixture ? await startFixture() : null
  const origin = fixture?.origin ?? (options.ownedStaging ? exactRemoteOrigin(options.origin) : exactLocalOrigin(options.origin))
  const allowedOrigins = new Set([origin, ...(fixture ? [fixture.crossOrigin] : [])])
  const checks = []
  const skipped = []
  let browser
  let timedOut = false
  let browserVersion = "unavailable"
  let nativeApiAvailable = false
  let runError = false
  const fixtureChecksum = fixture
    ? createHash("sha256").update(await readFile(new URL("../e2e/webmcp-runtime/fixture.mjs", import.meta.url))).digest("hex")
    : undefined
  try {
    const pinnedAddress = options.ownedStaging ? await pinRemoteOrigin(origin) : undefined
    browser = await launch({
      headless: true,
      executablePath: options.browser,
      args: ["--enable-features=WebMCP", "--disable-background-networking", "--no-first-run", "--no-proxy-server", ...(pinnedAddress ? [`--host-resolver-rules=MAP ${new URL(origin).hostname} ${pinnedAddress}`] : [])],
      timeout: 15_000,
    })
    browserVersion = browser.version()
    const legacyStringInput = Number(browserVersion.match(/^(\d+)/)?.[1] ?? 0) < 155
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false })
    await context.route("**/*", async (route) => {
      if (requestAllowed(route.request().url(), allowedOrigins)) await route.continue()
      else await route.abort("blockedbyclient")
    })
    if (!context.routeWebSocket) throw new Error("WebSocket interception unavailable")
    await context.routeWebSocket("**/*", (socket) => socket.close())
    const page = await context.newPage()
    let cdpAvailable = false
    const nativeRegistrations = new Set()
    try {
      const session = await context.newCDPSession(page)
      session.on("WebMCP.toolsAdded", (event) => {
        for (const tool of event.tools ?? []) nativeRegistrations.add(tool.name)
      })
      await session.send("WebMCP.enable")
      cdpAvailable = true
    } catch { /* Unsupported Chromium protocol is inconclusive. */ }
    await page.goto(origin, { waitUntil: "load", timeout: 10_000 })
    const observation = await page.evaluate(async () => {
      const api = document.modelContext
      if (!api || typeof api.getTools !== "function" || typeof api.executeTool !== "function") return { available: false, tools: [] }
      const nativeProperty = Object.getOwnPropertyDescriptor(Document.prototype, "modelContext")
      if (Object.hasOwn(document, "modelContext") || !nativeProperty?.get || !Function.prototype.toString.call(nativeProperty.get).includes("[native code]")) {
        return { available: false, tools: [] }
      }
      const tools = await api.getTools()
      return { available: true, tools: tools.map((tool) => ({ name: tool.name, schema: tool.inputSchema })) }
    })
    nativeApiAvailable = observation.available && cdpAvailable
    if (!nativeApiAvailable) {
      checks.push(check("NATIVE_API", "INCONCLUSIVE", "Native API or Chrome WebMCP protocol unavailable; no browser behavior verified."))
      checks.push(check("DISCOVERY", "INCONCLUSIVE", "Tool discovery needs native browser support."))
    } else {
      checks.push(check("NATIVE_API", "PASS", "Native API and Chrome WebMCP protocol available."))
      const discovered = observation.tools.some((tool) => nativeRegistrations.has(tool.name))
      checks.push(check("DISCOVERY", discovered ? "PASS" : "FAIL", discovered ? "Registered tool observed through native API and browser protocol." : "No matching registered tool observed through both native mechanisms."))
    }
    if (nativeApiAvailable && options.fixture && observation.tools.some((tool) => tool.name === "fixture_echo")) {
      const crossResult = await page.evaluate(async (crossOrigin) => {
        const tools = await document.modelContext.getTools({ fromOrigins: [crossOrigin] })
        return tools.some((tool) => tool.name === "fixture_private_cross")
      }, fixture.crossOrigin).catch(() => null)
      const crossFrame = page.frames().find((frame) => frame.url().startsWith(fixture.crossOrigin))
      const crossRegistered = crossFrame
        ? await crossFrame.evaluate(async () => (await document.modelContext?.getTools())?.some((tool) => tool.name === "fixture_private_cross") ?? false).catch(() => false)
        : false
      checks.push(check("CROSS_ORIGIN", !crossRegistered || crossResult === null ? "INCONCLUSIVE" : crossResult ? "FAIL" : "PASS", !crossRegistered || crossResult === null ? "Cross-origin registration or inspection unavailable for this fixture." : crossResult ? "Private cross-origin fixture tool was exposed." : "Registered private cross-origin fixture tool was not discoverable."))
      const fixtureChecks = await page.evaluate(async (legacyStringInput) => {
        const tools = await document.modelContext.getTools()
        const find = (name) => tools.find((tool) => tool.name === name)
        const input = (value) => legacyStringInput ? JSON.stringify(value) : value
        const before = window.fixtureState.calls
        let rejected = false
        try {
          const invalid = await document.modelContext.executeTool(find("fixture_echo"), input({ value: 123 }))
          rejected = !invalid || /error|invalid|expected/i.test(JSON.stringify(invalid))
        } catch { rejected = true }
        const noEffect = window.fixtureState.calls === before
        const result = await document.modelContext.executeTool(find("fixture_echo"), input({ value: "synthetic" }))
        const bounded = JSON.stringify(result).length <= 16_000
        const controller = new AbortController()
        const pending = document.modelContext.executeTool(find("fixture_slow"), input({}), { signal: controller.signal }).catch(() => null)
        for (let i = 0; i < 100 && !window.fixtureState.slowStarted; i++) await new Promise((resolve) => setTimeout(resolve, 10))
        controller.abort()
        await pending
        return { rejected: rejected && noEffect, bounded, aborted: window.fixtureState.aborted, signalProvided: window.fixtureState.signalProvided }
      }, legacyStringInput)
      checks.push(check("SCHEMA_REJECTION", fixtureChecks.rejected ? "PASS" : "FAIL", fixtureChecks.rejected ? "Invalid synthetic input rejected before fixture effect." : "Invalid input was accepted or fixture effect occurred."))
      checks.push(check("OUTPUT_BOUND", fixtureChecks.bounded ? "PASS" : "FAIL", fixtureChecks.bounded ? "Synthetic tool output stayed within 16 KiB." : "Synthetic tool output exceeded 16 KiB."))
      checks.push(check("CANCELLATION", !fixtureChecks.signalProvided ? "INCONCLUSIVE" : fixtureChecks.aborted ? "PASS" : "FAIL", !fixtureChecks.signalProvided ? "Browser did not supply an AbortSignal to the fixture handler." : fixtureChecks.aborted ? "Abort reached synthetic fixture handler." : "Synthetic handler did not observe abort."))
      page.once("dialog", (dialog) => dialog.dismiss())
      const confirmed = await page.evaluate(async (legacyStringInput) => {
        const tool = (await document.modelContext.getTools()).find((item) => item.name === "fixture_confirm")
        const input = legacyStringInput ? "{}" : {}
        await document.modelContext.executeTool(tool, input)
        return window.fixtureState.confirmed
      }, legacyStringInput)
      checks.push(check("CONFIRMATION", confirmed ? "FAIL" : "PASS", confirmed ? "Synthetic action proceeded after dismissal." : "Dismissed visible confirmation prevented synthetic effect."))
      await page.click("#next")
      const after = await page.evaluate(async () => (await document.modelContext.getTools()).some((tool) => tool.name === "fixture_echo"))
      checks.push(check("CLEANUP", after ? "FAIL" : "PASS", after ? "Fixture tool remained after navigation." : "Fixture tool was absent after navigation."))
    } else if (nativeApiAvailable && options.activeTools.length) {
      if ((await stat(options.inputFile)).size > 64 * 1024) throw new Error("Synthetic input file exceeds 64 KiB")
      const inputs = JSON.parse(await readFile(options.inputFile, "utf8"))
      if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) throw new Error("Expected a JSON object of named synthetic inputs")
      let outputsBounded = true
      for (const name of options.activeTools) {
        if (!Object.hasOwn(inputs, name) || !observation.tools.some((tool) => tool.name === name)) throw new Error(`Named tool unavailable or missing synthetic input: ${name}`)
        if (JSON.stringify(inputs[name]).length > 8 * 1024) throw new Error("Synthetic tool input exceeds 8 KiB")
        const size = await page.evaluate(async ({ name, input, legacyStringInput }) => {
          const tool = (await document.modelContext.getTools()).find((item) => item.name === name)
          const value = legacyStringInput ? JSON.stringify(input) : input
          return JSON.stringify(await document.modelContext.executeTool(tool, value)).length
        }, { name, input: inputs[name], legacyStringInput })
        outputsBounded &&= size <= 16_000
      }
      checks.push(check("OUTPUT_BOUND", outputsBounded ? "PASS" : "FAIL", outputsBounded ? "Selected synthetic outputs stayed within 16 KiB." : "A selected synthetic output exceeded 16 KiB."))
    }
    for (const id of checkIds) if (!checks.some((item) => item.id === id)) {
      skipped.push(id)
      checks.push(check(id, nativeApiAvailable ? "NOT_APPLICABLE" : "INCONCLUSIVE", nativeApiAvailable ? "Requires a dedicated owned fixture or explicitly selected safe invocation." : "Native browser support unavailable."))
    }
    await context.close()
  } catch (error) {
    timedOut = /timeout/i.test(String(error))
    runError = true
    for (const id of checkIds) if (!checks.some((item) => item.id === id)) {
      skipped.push(id)
      checks.push(check(id, "INCONCLUSIVE", "Browser run did not complete; inspect local runner error."))
    }
  } finally {
    await browser?.close()
    await fixture?.close()
  }
  return parseWebMcpRuntimeReceipt({
    schemaVersion: "lyrashield-webmcp-runtime/1", runId: randomUUID(), checkedAt: new Date().toISOString(),
    browser: { name: "Chromium", version: browserVersion, nativeApiAvailable },
    target: { origin, ...(options.revision ? { revision: options.revision } : {}), ...((fixtureChecksum ?? options.checksum) ? { contentChecksum: fixtureChecksum ?? options.checksum } : {}) },
    checks, limits: { timedOut, skipped: runError ? [...new Set(skipped)] : skipped },
  })
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const options = parseOptions(process.argv.slice(2))
    const receipt = await run(options)
    await writeFile(options.output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    process.stdout.write(`${receipt.checks.map((item) => `${item.id}:${item.state}`).join(" ")}\n`)
    process.exitCode = receipt.checks.some((item) => item.state === "FAIL") ? 1 : receipt.checks.some((item) => item.state === "INCONCLUSIVE") ? 2 : 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}
