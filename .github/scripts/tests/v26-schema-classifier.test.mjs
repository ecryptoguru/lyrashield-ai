import assert from "node:assert/strict"
import test from "node:test"
import { classifyV26Schema } from "../v26-schema-classifier.mjs"

const expected = [
  { name: "20261030103000_scan_admission_capacity", checksum: "a".repeat(64) },
  { name: "20261030103100_scan_accounting_release", checksum: "b".repeat(64) },
  { name: "20261030104500_fix_pr_execution_identity", checksum: "c".repeat(64) },
  { name: "20261030110000_schedule_admission", checksum: "d".repeat(64) },
]
function client({ flags = false, rows = [], global = true, rollbackFails = false } = {}) {
  return {
    async query(sql) {
      if (sql.includes("global_read")) return { rows: [{ global_read: global }] }
      if (sql.includes(" AS slot"))
        return { rows: [{ slot: flags, capacity: flags, version: flags, settled: flags }] }
      if (sql.includes("_prisma_migrations")) return { rows }
      if (sql === "ROLLBACK" && rollbackFails) throw new Error("private postgres failure")
      return { rows: [] }
    },
  }
}

test("classifies only complete legacy or checksum-qualified current schema", async () => {
  assert.equal(await classifyV26Schema(client(), expected), "legacy")
  const rows = expected.map((row) => ({
    migration_name: row.name,
    checksum: row.checksum,
    finished: true,
    rolled_back: false,
  }))
  assert.equal(await classifyV26Schema(client({ flags: true, rows }), expected), "current")
})

test("rejects mixed state, invisible role, bad checksum and failed transaction", async () => {
  const rows = expected.map((row) => ({
    migration_name: row.name,
    checksum: row.checksum,
    finished: true,
    rolled_back: false,
  }))
  await assert.rejects(classifyV26Schema(client({ flags: false, rows }), expected))
  await assert.rejects(classifyV26Schema(client({ flags: true, rows: rows.slice(0, 1) }), expected))
  await assert.rejects(
    classifyV26Schema(
      client({ flags: true, rows: [{ ...rows[0], checksum: "c".repeat(64) }, rows[1]] }),
      expected
    )
  )
  await assert.rejects(classifyV26Schema(client({ global: false }), expected))
  await assert.rejects(classifyV26Schema(client({ rollbackFails: true }), expected))
  await assert.rejects(classifyV26Schema(client(), [...expected].reverse()))
})
