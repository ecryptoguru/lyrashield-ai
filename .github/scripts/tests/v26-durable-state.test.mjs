import assert from "node:assert/strict"
import test from "node:test"
import { randomBytes } from "node:crypto"
import { mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  claimDurableStop,
  requireOwnedStop,
  recordPhase,
  releaseDurableStop,
  readDurableReceipt,
  persistDurableReceipt,
  STOP_KEY,
} from "../v26-durable-state.mjs"
const identity = () => ({
  runId: "123",
  attempt: 1,
  owner: "123:1",
  sourceRevision: randomBytes(20).toString("hex"),
  engineRevision: randomBytes(20).toString("hex"),
  workerDigest: "sha256:" + randomBytes(32).toString("hex"),
  webDigest: "sha256:" + randomBytes(32).toString("hex"),
  databaseIdentity: randomBytes(32).toString("hex"),
  redisIdentity: randomBytes(32).toString("hex"),
})
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "v26-receipt-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, "receipt.json")
  let value = null
  const redis = {
    get: async (key) => {
      assert.equal(key, STOP_KEY)
      return value
    },
    set: async (key, next, mode) => {
      assert.equal(mode, "NX")
      if (value === null) {
        value = next
        return "OK"
      }
      return null
    },
    eval: async (_lua, _count, _key, expected) => {
      if (value === expected) {
        value = null
        return 1
      }
      return 0
    },
  }
  const store = {
    read: () => readDurableReceipt(path, process.getuid()),
    write: (receipt) => persistDurableReceipt(path, receipt),
  }
  return {
    path,
    store,
    redis,
    request: identity(),
    baseline: {},
    replace: (next) => {
      value = next
    },
  }
}
async function verified(context) {
  await claimDurableStop(context)
  for (const phase of ["QUIESCED", "INVENTORIED", "MIGRATION_INTENT", "MIGRATED", "VERIFIED"])
    await recordPhase(context, phase, {})
}
test("durable intent precedes NX, and lost claim reply never adopts a new attempt", async (t) => {
  const context = fixture(t)
  const set = context.redis.set
  context.redis.set = async (...args) => {
    assert.equal(context.store.read().phase, "INTENT")
    await set(...args)
    throw new Error("lost reply")
  }
  await assert.rejects(claimDurableStop(context))
  assert.equal(context.store.read().phase, "INTENT")
  context.redis.set = set
  await assert.rejects(
    claimDurableStop({ ...context, request: { ...context.request, attempt: 2, owner: "123:2" } })
  )
  const receipt = await claimDurableStop(context)
  assert.equal(receipt.phase, "CLAIMED")
  assert.equal(receipt.identity.owner, "123:1")
  assert.equal(JSON.parse(receipt.stop).owner, "123:1")
})
test("foreign stop, lost stop and connection/image drift never authorize acquisition", async (t) => {
  const context = fixture(t)
  context.replace("foreign")
  await assert.rejects(claimDurableStop(context))
  assert.equal(context.store.read(), null)
  context.replace(null)
  await claimDurableStop(context)
  context.replace(null)
  await assert.rejects(claimDurableStop(context))
  for (const key of [
    "sourceRevision",
    "workerDigest",
    "webDigest",
    "databaseIdentity",
    "redisIdentity",
  ])
    await assert.rejects(
      requireOwnedStop({ ...context, request: { ...context.request, [key]: "changed" } })
    )
})
test("uncertain migration is durably held and retry does not regress phases", async (t) => {
  const context = fixture(t)
  await claimDurableStop(context)
  for (const phase of ["QUIESCED", "INVENTORIED", "MIGRATION_INTENT"])
    await recordPhase(context, phase, {})
  await assert.rejects(recordPhase(context, "VERIFIED", {}))
  await assert.rejects(
    claimDurableStop({ ...context, request: { ...context.request, attempt: 2, owner: "123:2" } })
  )
  assert.equal(context.store.read().phase, "MIGRATION_INTENT")
  await recordPhase(context, "MIGRATED", {})
})
test("lost release reply reconciles only durable intent and exact candidate; foreign replacement remains", async (t) => {
  const context = fixture(t)
  await verified(context)
  context.redis.eval = async () => {
    assert.equal(context.store.read().phase, "RELEASE_INTENT")
    context.replace(null)
    throw new Error("lost CAS reply")
  }
  let checks = 0
  await releaseDurableStop(context, async () => {
    checks++
  })
  assert.equal(context.store.read().phase, "COMPLETE")
  await releaseDurableStop(context, async () => {
    checks++
  })
  assert.equal(checks, 2)
  context.replace("newer owner")
  await assert.rejects(releaseDurableStop(context, async () => {}))
  assert.equal(await context.redis.get(STOP_KEY), "newer owner")
})
test("candidate proof failure cannot release owned admission", async (t) => {
  const context = fixture(t)
  await verified(context)
  await assert.rejects(
    releaseDurableStop(context, async () => {
      throw new Error("unhealthy")
    })
  )
  assert.equal(await context.redis.get(STOP_KEY), context.store.read().stop)
  assert.equal(context.store.read().phase, "VERIFIED")
})
test("durable receipt rejects symlinks and wrong ownership", (t) => {
  const context = fixture(t)
  context.store.write({ value: true })
  assert.throws(() => readDurableReceipt(context.path, process.getuid() + 1))
  const link = context.path + ".link"
  // Test paths are confined to this test’s disposable directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  symlinkSync(context.path, link)
  assert.throws(() => readDurableReceipt(link, process.getuid()))
})
