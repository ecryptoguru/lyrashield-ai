import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"

const require = createRequire(
  new URL("../../../packages/integrations/package.json", import.meta.url)
)
const { Queue, FlowProducer } = require("bullmq")

test("maintenance drain detects paused and waiting-for-children jobs in disposable Redis", async (t) => {
  assert.equal(process.env.LYRASHIELD_TEST_DB_DISPOSABLE, "1")
  const target = new URL(process.env.REDIS_URL ?? "")
  assert.equal(target.protocol, "redis:")
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))
  assert.ok(["6379", "16379"].includes(target.port || "6379"))
  assert.equal(target.username, "")
  assert.equal(target.password, "")
  const source = readFileSync(new URL("../webhook-claims-vm.sh", import.meta.url), "utf8")
  const states = JSON.parse(`[${source.match(/scan\.getJobCounts\(([^)]+)\)/)?.[1]}]`)
  const connection = { host: target.hostname, port: Number(target.port || "6379") }
  const suffix = randomBytes(8).toString("hex")
  const paused = new Queue(`catalog-paused-${suffix}`, { connection })
  const parent = new Queue(`catalog-parent-${suffix}`, { connection })
  const child = new Queue(`catalog-child-${suffix}`, { connection })
  const flow = new FlowProducer({ connection })
  t.after(async () => {
    try {
      for (const queue of [parent, child, paused]) await queue.obliterate({ force: true })
    } finally {
      await Promise.all([flow.close(), parent.close(), child.close(), paused.close()])
    }
  })
  const previousStates = ["wait", "active", "delayed", "prioritized"]
  await paused.pause()
  await paused.add("fixture", {})
  // BullMQ 6 keeps jobs in wait while paused; the complete drain inventory
  // must continue rejecting that state as well as waiting-for-children.
  assert.ok(Object.values(await paused.getJobCounts(...states)).some((count) => count > 0))
  await flow.add({
    name: "parent",
    queueName: parent.name,
    data: {},
    children: [{ name: "child", queueName: child.name, data: {} }],
  })
  assert.ok(
    Object.values(await parent.getJobCounts(...previousStates)).every((count) => count === 0)
  )
  assert.equal((await parent.getJobCounts(...states))["waiting-children"], 1)
})
