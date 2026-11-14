import pg from "pg"
import {
  canonicalJson,
  sha256Hex,
  supervisorAttemptProofSchema,
  type SupervisorAttemptProof,
} from "@lyrashield/runtime-control"
import { createPgConnectionConfig } from "./connection-config"

/** Installed only beside the supervisor private signing key, with a separate proof-only login. */
export async function createScanDispatchLifecycleProofRegistrar(connectionString: string) {
  const pool = new pg.Pool({
    ...createPgConnectionConfig(connectionString),
    max: 1,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    statement_timeout: 5000,
    query_timeout: 6000,
  })
  pool.on("error", () => undefined)
  try {
    await pool.query("SELECT app.require_scan_dispatch_proof_role()")
  } catch {
    await pool.end()
    throw new Error("Protected lifecycle proof registration is unavailable")
  }
  return {
    async register(value: SupervisorAttemptProof) {
      const client = await pool.connect()
      let acknowledged = false
      try {
        await client.query("SELECT app.require_scan_dispatch_proof_role()")
        const bytes = canonicalJson(supervisorAttemptProofSchema.parse(value))
        if (Buffer.byteLength(bytes) > 16384) throw new Error("Lifecycle proof exceeds its bound")
        const result = await client.query<{ checksum: string }>(
          "SELECT app.register_scan_dispatch_lifecycle_proof($1) AS checksum",
          [bytes]
        )
        if (result.rows.length !== 1 || result.rows[0]?.checksum !== sha256Hex(bytes))
          throw new Error("Lifecycle proof registration was not acknowledged")
        acknowledged = true
      } catch {
        throw new Error("Protected lifecycle proof registration was not acknowledged")
      } finally {
        client.release(!acknowledged)
      }
    },
    close: () => pool.end(),
  }
}
