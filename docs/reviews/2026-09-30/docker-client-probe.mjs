// Operates only on packed local client artifacts inside an ephemeral container.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"

console.log(execFileSync("/app/node_modules/.bin/lyrashield", ["--version"], { encoding: "utf8" }))
assert.match(
  execFileSync("/app/node_modules/.bin/lyrashield", ["--help"], { encoding: "utf8" }),
  /scan|login/
)
const child = spawn("node", ["/app/node_modules/@lyrashield/mcp/bin/lyrashield-mcp.mjs"], {
  env: {
    PATH: process.env.PATH,
    LYRASHIELD_API_KEY: `lsk_${"A".repeat(24)}`,
    LYRASHIELD_API_URL: "http://127.0.0.1:9",
  },
  stdio: ["pipe", "pipe", "pipe"],
})
let buffer = ""
const responses = []
child.stderr.pipe(process.stderr)
const completed = new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    child.kill()
    reject(new Error("MCP fixture timed out"))
  }, 30_000)
  child.stdout.on("data", (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line)
      assert.equal(message.jsonrpc, "2.0")
      responses.push(message)
      if (message.id === 2) child.kill()
    }
  })
  child.on("error", reject)
  child.on("close", () => {
    clearTimeout(timer)
    try {
      assert(responses.find((r) => r.id === 1)?.result?.protocolVersion)
      const tools = responses.find((r) => r.id === 2)?.result?.tools
      assert(Array.isArray(tools) && tools.length > 0)
      console.log(
        JSON.stringify({
          passed: true,
          protocolVersion: responses.find((r) => r.id === 1).result.protocolVersion,
          toolCount: tools.length,
          names: tools.map((t) => t.name),
        })
      )
      resolve()
    } catch (error) {
      reject(error)
    }
  })
})
for (const message of [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "disposable-docker-fixture", version: "1" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
])
  child.stdin.write(JSON.stringify(message) + "\n")
await completed
