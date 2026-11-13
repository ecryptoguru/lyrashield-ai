import assert from "node:assert/strict"
import test from "node:test"
import { randomBytes } from "node:crypto"
import { runFirstV26Phase } from "../v26-cutover-orchestration.mjs"
import {
  claimDurableStop,
  requireOwnedStop,
  recordPhase,
  releaseDurableStop,
} from "../v26-durable-state.mjs"
const phases = ["claim", "quiesce", "before-migrate", "after-migrate", "verify", "release"]
const token = (length) => randomBytes(length).toString("hex")
function platform(failAt) {
  let receipt = null,
    stop = null
  const state = {
    oldAppRevisions: 2,
    oldScannerRevisions: 2,
    oldReplicas: 4,
    oldWorker: true,
    detached: 0,
    queues: 0,
    executions: 0,
    accounting: 0,
    schema: "legacy",
    grants: false,
    candidate: false,
    events: [],
  }
  const context = {
    request: {
      runId: "123",
      attempt: 1,
      owner: "123:1",
      sourceRevision: token(20),
      engineRevision: token(20),
      workerDigest: `sha256:${token(32)}`,
      webDigest: `sha256:${token(32)}`,
      databaseIdentity: token(32),
      redisIdentity: token(32),
    },
    baseline: {},
    store: {
      read: () => receipt && structuredClone(receipt),
      write: (value) => {
        receipt = structuredClone(value)
      },
    },
    redis: {
      get: async () => stop,
      set: async (_key, value) => {
        if (stop === null) {
          stop = value
          return "OK"
        }
        return null
      },
      eval: async (_code, _n, _key, value) => {
        if (stop !== value) return 0
        stop = null
        return 1
      },
    },
  }
  const owned = () => requireOwnedStop(context)
  const inactive = () => {
    assert.equal(state.oldAppRevisions + state.oldScannerRevisions + state.oldReplicas, 0)
  }
  const empty = () => {
    assert.equal(state.queues + state.executions + state.accounting + state.detached, 0)
  }
  const fleet = () => {
    assert.equal(state.candidate, true)
    assert.equal(state.oldWorker, false)
    inactive()
  }
  const service = {
    claim: () => claimDurableStop(context),
    owned,
    deactivate: () => {
      state.oldAppRevisions = 0
      state.oldScannerRevisions = 0
      state.oldReplicas = 0
    },
    inactive,
    drain: async () => {
      await owned()
      empty()
    },
    stop: async () => {
      empty()
      inactive()
      state.oldWorker = false
      await recordPhase(context, "QUIESCED", { freshStopProvenance: true })
    },
    quiesced: async () => {
      await owned()
      assert.equal(state.oldWorker, false)
      empty()
    },
    inventory: async () => {
      empty()
      await recordPhase(context, "INVENTORIED", { completeGlobalInventory: true })
    },
    legacySchema: () => assert.equal(state.schema, "legacy"),
    accounting: empty,
    migrationIntent: () => recordPhase(context, "MIGRATION_INTENT", { exactFourMigrations: true }),
    grant: () => {
      assert.equal(state.schema, "current")
      state.grants = true
    },
    postMigration: () => {
      assert.equal(state.schema, "current")
      assert.equal(state.grants, true)
      empty()
    },
    migrated: () => recordPhase(context, "MIGRATED", { exactMigrationHashesAndRls: true }),
    candidateFleet: fleet,
    verified: () => recordPhase(context, "VERIFIED", { actualFleetAndProvenance: true }),
    release: () => releaseDurableStop(context, fleet),
  }
  for (const [name, action] of Object.entries(service))
    service[name] = async () => {
      state.events.push(name)
      if (name === failAt) throw new Error("external observation unavailable")
      return await action()
    }
  return {
    state,
    service,
    context,
    receipt: () => receipt,
    stop: () => stop,
    replaceStop: (value) => {
      stop = value
    },
    migrate() {
      assert.equal(receipt.phase, "MIGRATION_INTENT")
      inactive()
      assert.equal(state.oldWorker, false)
      empty()
      state.schema = "current"
      state.events.push("actual-migration")
    },
    boot() {
      assert.equal(receipt.phase, "MIGRATED")
      assert.equal(state.oldWorker, false)
      inactive()
      state.candidate = true
      state.events.push("actual-candidate-boot")
    },
  }
}
async function complete(platform) {
  for (const phase of phases) {
    if (phase === "after-migrate") platform.migrate()
    if (phase === "verify") platform.boot()
    await runFirstV26Phase(phase, platform.service)
  }
}
test("complete one-time positive path uses durable ownership through migration and candidate boot", async () => {
  const p = platform()
  await complete(p)
  assert.equal(p.receipt().phase, "COMPLETE")
  assert.equal(p.receipt().recoveryPolicy, "REPAIR_FORWARD_ONLY")
  assert.equal(p.stop(), null)
  assert.equal(p.state.candidate, true)
  assert.ok(p.state.events.indexOf("actual-migration") > p.state.events.indexOf("migrationIntent"))
  assert.ok(
    p.state.events.indexOf("actual-candidate-boot") > p.state.events.indexOf("postMigration")
  )
  assert.ok(p.state.events.indexOf("release") > p.state.events.indexOf("verified"))
})
test("every authoritative phase failure retains admission and never restores an old writer", async (t) => {
  for (const failAt of [
    "owned",
    "deactivate",
    "drain",
    "stop",
    "inactive",
    "inventory",
    "quiesced",
    "legacySchema",
    "accounting",
    "migrationIntent",
    "grant",
    "postMigration",
    "migrated",
    "candidateFleet",
    "verified",
    "release",
  ])
    await t.test(failAt, async () => {
      const p = platform(failAt)
      await assert.rejects(complete(p))
      assert.equal(p.stop(), p.receipt().stop)
      assert.notEqual(p.receipt().phase, "COMPLETE")
      if (p.state.schema === "current") {
        assert.equal(p.state.oldWorker, false)
        assert.equal(p.state.oldAppRevisions + p.state.oldScannerRevisions + p.state.oldReplicas, 0)
      }
      assert.equal(
        p.state.events.some((name) => /rollback|restore|cancel|replay/i.test(name)),
        false
      )
    })
})
test("scan, fix, webhook, adjacent mutation, detached execution and accounting blockers prevent migration", async () => {
  for (const key of ["queues", "executions", "detached", "accounting"]) {
    const p = platform()
    p.state[key] = 1
    await assert.rejects(complete(p))
    assert.equal(p.state.schema, "legacy")
    assert.equal(p.stop(), p.receipt().stop)
  }
})
test("stop loss or a foreign replacement between observations blocks migration and cleanup", async () => {
  for (const replacement of [null, "foreign-stop"]) {
    const p = platform()
    await runFirstV26Phase("claim", p.service)
    await runFirstV26Phase("quiesce", p.service)
    p.replaceStop(replacement)
    await assert.rejects(runFirstV26Phase("before-migrate", p.service))
    await assert.rejects(runFirstV26Phase("hold", p.service))
    assert.equal(p.stop(), replacement)
    assert.equal(p.state.schema, "legacy")
  }
})
test("failure cleanup cannot deactivate a completed healthy fleet or adopt a new attempt", async () => {
  const p = platform()
  await complete(p)
  const count = p.state.events.filter((name) => name === "deactivate").length
  await assert.rejects(runFirstV26Phase("hold", p.service))
  assert.equal(p.state.events.filter((name) => name === "deactivate").length, count)
  assert.equal(p.state.candidate, true)
  await assert.rejects(
    claimDurableStop({
      ...p.context,
      request: { ...p.context.request, attempt: 2, owner: "123:2" },
    })
  )
})
