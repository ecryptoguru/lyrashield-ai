import { createServer } from "node:net"
import { once } from "node:events"
import Redis from "ioredis"
import { expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  client: null as Redis | null,
  env: { LYRASHIELD_AI_CACHE_KEY_SECRET: "k".repeat(32) },
}))
vi.mock("@lyrashield/config", () => ({ env: mocks.env }))
vi.mock("./redis", () => ({ getAiResultCacheRedisForPurge: () => mocks.client }))
import {
  aiResultCacheTargetIndexKey,
  purgeAiResultCacheWorkspaceEntries,
} from "./ai-result-cache-admin"

// Minimal loopback RESP transport: exercise the real ioredis readiness lifecycle.
function commandFrom(buffer: Buffer): { args: string[]; bytes: number } | null {
  const first = buffer.indexOf("\r\n")
  if (first < 0) return null
  const count = Number(buffer.subarray(1, first).toString())
  const args: string[] = []
  let offset = first + 2
  for (let i = 0; i < count; i++) {
    const end = buffer.indexOf("\r\n", offset)
    if (end < 0) return null
    const size = Number(buffer.subarray(offset + 1, end).toString())
    offset = end + 2
    if (buffer.length < offset + size + 2) return null
    args.push(buffer.subarray(offset, offset + size).toString())
    offset += size + 2
  }
  return { args, bytes: offset }
}

it("purges both targets through a shared cold ioredis connection", async () => {
  const indexes = new Map([
    [
      aiResultCacheTargetIndexKey(mocks.env.LYRASHIELD_AI_CACHE_KEY_SECRET, "ws", "one"),
      "entry-one",
    ],
    [
      aiResultCacheTargetIndexKey(mocks.env.LYRASHIELD_AI_CACHE_KEY_SECRET, "ws", "two"),
      "entry-two",
    ],
  ])
  const remaining = new Set([...indexes.keys(), ...indexes.values()])
  const server = createServer((socket) => {
    let buffered = Buffer.alloc(0)
    socket.on("data", (data) => {
      buffered = Buffer.concat([buffered, data])
      let parsed: ReturnType<typeof commandFrom>
      while ((parsed = commandFrom(buffered))) {
        buffered = buffered.subarray(parsed.bytes)
        const [command, ...keys] = parsed.args
        if (command?.toLowerCase() === "smembers") {
          const entry = indexes.get(keys[0]!)
          socket.write(entry ? `*1\r\n$${Buffer.byteLength(entry)}\r\n${entry}\r\n` : "*0\r\n")
        } else if (command?.toLowerCase() === "del") {
          socket.write(`:${keys.filter((key) => remaining.delete(key)).length}\r\n`)
        } else {
          socket.write("+OK\r\n")
        }
      }
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Loopback port unavailable")
  const client = new Redis(address.port, "127.0.0.1", {
    lazyConnect: true,
    enableOfflineQueue: false,
    enableReadyCheck: false,
    maxRetriesPerRequest: 0,
    connectTimeout: 500,
    commandTimeout: 500,
    retryStrategy: () => null,
  })
  mocks.client = client
  try {
    const results = await Promise.all([
      purgeAiResultCacheWorkspaceEntries("ws", ["one"]),
      purgeAiResultCacheWorkspaceEntries("ws", ["two"]),
    ])
    expect(results).toEqual([
      { available: true, targetsVisited: 1, entriesDeleted: 1 },
      { available: true, targetsVisited: 1, entriesDeleted: 1 },
    ])
    expect(remaining.size).toBe(0)
  } finally {
    mocks.client = null
    client.disconnect()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})
