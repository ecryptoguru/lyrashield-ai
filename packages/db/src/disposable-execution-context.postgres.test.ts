import { readFileSync } from "node:fs"
import pg from "pg"
import { describe, expect, it, vi } from "vitest"
import { observeDisposableExecutionContext } from "./disposable-preparation-observations"

// Hoisting runs this guard before the pool can connect. This harness re-observes
// the single disposable database through DATABASE_URL, so bind that one database
// to both sides of the shared disposable-pair guard.
await vi.hoisted(async () => {
  if (process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1") return
  const { assertDisposableDatabasePair } =
    await import("../../../.github/scripts/vitest-database-env.mjs")
  assertDisposableDatabasePair({
    ...process.env,
    RLS_RUNTIME_DATABASE_URL: process.env.DATABASE_URL,
  })
})

const enabled = process.env.LYRA_DISPOSABLE_CONTEXT_TEST === "1"
describe.skipIf(!enabled)("owned disposable execution context", () => {
  it("reobserves the same database used by the restricted compiler fixture", async () => {
    const env = process.env
    const fixture = {
      databaseContainer: env.LYRA_CONTEXT_DATABASE_CONTAINER!,
      providerContainer: env.LYRA_CONTEXT_PROVIDER_CONTAINER!,
      owner: env.LYRA_CONTEXT_OWNER!,
      relayPid: Number(env.LYRA_CONTEXT_DATABASE_RELAY_PID),
      relayPortFile: env.LYRA_CONTEXT_DATABASE_RELAY_PORT_FILE!,
      providerRelayPid: Number(env.LYRA_CONTEXT_PROVIDER_RELAY_PID),
      providerRelayPortFile: env.LYRA_CONTEXT_PROVIDER_RELAY_PORT_FILE!,
      database: "lyrashield_test",
    }
    const retained = JSON.parse(readFileSync(env.LYRA_CONTEXT_RECORD!, "utf8"))
    const first = observeDisposableExecutionContext(fixture)
    const second = observeDisposableExecutionContext(fixture)
    expect(first.context).toEqual(retained.context)
    expect(second.context).toEqual(first.context)
    const pool = new pg.Pool({ connectionString: env.DATABASE_URL })
    try {
      const result = await pool.query(
        "SELECT system_identifier::text AS system_id, d.oid::text AS database_oid FROM pg_control_system(), pg_database d WHERE d.datname=current_database()"
      )
      expect(result.rows).toEqual([
        {
          system_id: first.evidence.evidence.database.systemIdentifier,
          database_oid: first.evidence.evidence.database.databaseOid,
        },
      ])
    } finally {
      await pool.end()
    }
  }, 60_000)
})
