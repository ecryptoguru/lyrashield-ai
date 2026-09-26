/* eslint-disable security/detect-non-literal-fs-filename */
import { execFile, execFileSync, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js"

const runFile = promisify(execFile)
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url))

/**
 * Proves the SHIPPED artifact — not the source tree — speaks MCP over stdio:
 * `pnpm pack` the workspace package, extract the tarball, and spawn the real
 * published entry (`bin/lyrashield-mcp.mjs`, which loads `dist/stdio-transport.js`)
 * under a synthetic HOME and an unreachable loopback API URL so no tool call can
 * ever leave the machine.
 *
 * The extract dir lives inside the package directory so Node's upward module
 * resolution finds this workspace's `@modelcontextprotocol/sdk` and `zod`
 * (the only runtime deps left external by tsup; `@lyrashield/*` is bundled in).
 */

let extractDir: string
let pkgDir: string

beforeAll(async () => {
  if (!existsSync(path.join(PACKAGE_ROOT, "dist", "stdio-transport.js"))) {
    execFileSync("pnpm", ["exec", "tsup"], { cwd: PACKAGE_ROOT, stdio: "inherit" })
  }
  // Sweep leftovers from killed runs so they can never be packed or committed.
  for (const entry of await readdir(PACKAGE_ROOT)) {
    if (entry.startsWith(".packed-stdio-")) {
      await rm(path.join(PACKAGE_ROOT, entry), { recursive: true, force: true })
    }
  }
  extractDir = await mkdtemp(path.join(PACKAGE_ROOT, ".packed-stdio-"))
  await runFile("pnpm", ["pack", "--pack-destination", extractDir], { cwd: PACKAGE_ROOT })
  const tarball = (await readdir(extractDir)).find((f) => f.endsWith(".tgz"))
  if (!tarball) throw new Error("pnpm pack produced no tarball")
  await runFile("tar", ["-xzf", path.join(extractDir, tarball), "-C", extractDir])
  pkgDir = path.join(extractDir, "package")
}, 120_000)

afterAll(async () => {
  await rm(extractDir, { recursive: true, force: true })
})

interface JsonRpcLine {
  id?: number
  method?: string
  result?: Record<string, unknown>
  error?: { code?: number; message?: string }
}

/**
 * Spawn the packed server, feed it one JSON-RPC message per line, and collect
 * every stdout line until `awaitIds` have been answered. Every stdout line MUST
 * parse as a JSON-RPC message — a stray log on stdout would corrupt framing.
 */
function stdioExchange(messages: unknown[], awaitIds: number[]): Promise<JsonRpcLine[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(pkgDir, "bin", "lyrashield-mcp.mjs")], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: extractDir, // no real ~/.lyrashield/credentials.json
        LYRASHIELD_API_KEY: `lsk_${"A".repeat(24)}`,
        LYRASHIELD_API_URL: "http://127.0.0.1:9", // loopback discard port — unreachable
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const lines: JsonRpcLine[] = []
    let buffer = ""
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error("packed stdio server did not answer in 60s"))
    }, 60_000)

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString()
      let end
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (!line.trim()) continue
        try {
          lines.push(JSON.parse(line) as JsonRpcLine)
        } catch {
          child.kill()
          reject(new Error(`packed stdio server wrote non-JSON-RPC stdout: ${line}`))
          return
        }
        if (awaitIds.every((id) => lines.some((l) => l.id === id))) {
          child.kill()
        }
      }
    })
    child.on("error", reject)
    child.on("close", () => {
      clearTimeout(timer)
      if (awaitIds.every((id) => lines.some((l) => l.id === id))) resolve(lines)
      else reject(new Error(`packed stdio server closed without answering ${awaitIds}`))
    })
    for (const message of messages) {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    }
  })
}

const initialize = (id: number, protocolVersion: string) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "packed-stdio-test", version: "1" },
  },
})

describe("packed @lyrashield/mcp stdio artifact", () => {
  it(
    "completes initialize + tools/list over real stdio on the latest protocol",
    { timeout: 120_000 },
    async () => {
      const lines = await stdioExchange(
        [
          initialize(1, LATEST_PROTOCOL_VERSION),
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        ],
        [1, 2]
      )
      const init = lines.find((l) => l.id === 1)
      expect(init?.result?.protocolVersion).toBe(LATEST_PROTOCOL_VERSION)
      expect((init?.result?.serverInfo as { name?: string })?.name).toBe("lyrashield-mcp")
      const tools = (lines.find((l) => l.id === 2)?.result?.tools ?? []) as Array<{
        name: string
      }>
      expect(tools.map((t) => t.name)).toContain("lyrashield_list_workspaces")
      expect(tools.length).toBe(21)
    }
  )

  it.each(SUPPORTED_PROTOCOL_VERSIONS)(
    "packed stdio negotiates SDK-supported version %s",
    { timeout: 120_000 },
    async (protocolVersion) => {
      const lines = await stdioExchange([initialize(1, protocolVersion)], [1])
      expect(lines.find((l) => l.id === 1)?.result?.protocolVersion).toBe(protocolVersion)
    }
  )

  it(
    "packed stdio never echoes an unsupported version and fail-closes server/discover",
    { timeout: 120_000 },
    async () => {
      // Negotiation: an unknown/future version is answered with the newest
      // supported one — the server never claims "2026-07-28" itself.
      const lines = await stdioExchange(
        [
          initialize(1, "2026-07-28"),
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { jsonrpc: "2.0", id: 3, method: "server/discover", params: {} },
        ],
        [1, 3]
      )
      expect(lines.find((l) => l.id === 1)?.result?.protocolVersion).toBe(LATEST_PROTOCOL_VERSION)
      const discover = lines.find((l) => l.id === 3)
      expect(discover?.error?.code).toBe(-32601)
      expect(discover?.error?.message).toContain("Method not found")
    }
  )
})
