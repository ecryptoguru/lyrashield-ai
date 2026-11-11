import { spawn, type ChildProcess } from "node:child_process"
import { access, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

const roots: string[] = []
const children = new Set<ChildProcess>()

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL")
  children.clear()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no test port")
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  return address.port
}

function run(serviceName: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: join(process.cwd(), "apps", serviceName),
    env: { PATH: process.env.PATH, NODE_ENV: "test", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  children.add(child)
  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8")
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => {
        children.delete(child)
        resolve({ code, signal })
      })
    }
  )
  const ready = new Promise<void>((resolve, reject) => {
    let output = ""
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8")
      if (output.includes('"status":"ready"')) resolve()
    })
    void exited.then(() => reject(new Error(`service exited before readiness: ${stderr}`)))
  })
  return { child, ready, exited }
}

describe("runtime journal lifecycle", () => {
  it.each(["supervisor", "provider-gateway"])(
    "%s fences a second process and hands over after graceful shutdown",
    async (serviceName) => {
      const root = await mkdtemp(join(tmpdir(), "runtime-lifecycle-"))
      roots.push(root)
      const journalPath = join(root, "journal.jsonl")
      const port = await freePort()
      const shared = {
        LYRASHIELD_RUNTIME_ADMISSION: "closed",
        LYRASHIELD_PROVIDER_GATEWAY_JOURNAL_PATH: journalPath,
        LYRASHIELD_PROVIDER_GATEWAY_SIGNING_SECRET: "s".repeat(48),
        LYRASHIELD_PROVIDER_GATEWAY_RESPONSE_ENCRYPTION_SECRET: "e".repeat(48),
        LYRASHIELD_PROVIDER_GATEWAY_CONTROL_TOKEN: "t".repeat(48),
        LYRASHIELD_PROVIDER_GATEWAY_PORT: String(port),
        LYRASHIELD_PROVIDER_ROUTES_JSON: "[]",
        LYRASHIELD_PROVIDER_GATEWAY_URL: "http://127.0.0.1:8791",
        LYRASHIELD_SUPERVISOR_JOURNAL_PATH: journalPath,
        LYRASHIELD_SUPERVISOR_SIGNING_SECRET: "s".repeat(48),
        LYRASHIELD_SUPERVISOR_CONTROL_TOKEN: "t".repeat(48),
        LYRASHIELD_SUPERVISOR_INSTANCE_ID: "supervisor-lifecycle",
        LYRASHIELD_SUPERVISOR_CGROUP_ROOT: root,
        LYRASHIELD_SUPERVISOR_PORT: String(port),
      }
      const first = run(serviceName, shared)
      await first.ready
      const overlap = run(serviceName, shared)
      void overlap.ready.catch(() => undefined)
      expect((await overlap.exited).code).not.toBe(0)
      first.child.kill("SIGTERM")
      expect((await first.exited).code).toBe(0)
      await expect(access(`${journalPath}.lock`)).rejects.toThrow()
      const next = run(serviceName, shared)
      await next.ready
      next.child.kill("SIGTERM")
      expect((await next.exited).code).toBe(0)
    },
    15_000
  )
})
