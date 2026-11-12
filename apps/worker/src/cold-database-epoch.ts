import { createHash } from "node:crypto"
import { prisma } from "@lyrashield/db"

export interface DatabaseEpochReader {
  $queryRaw<T>(query: TemplateStringsArray): Promise<T>
}

/** Public PostgreSQL incarnation identity; no workspace data or privileged role is needed. */
export async function readColdDatabaseEpochHash(reader: DatabaseEpochReader = prisma) {
  const rows = await reader.$queryRaw<Array<{ epoch: string | null }>>`
    SELECT extract(epoch from pg_postmaster_start_time())::text AS epoch
  `
  const epoch = rows.length === 1 ? rows[0]?.epoch : null
  if (typeof epoch !== "string" || !/^\d+\.\d+$/.test(epoch)) {
    throw new Error("Database epoch unavailable")
  }
  return createHash("sha256").update(epoch).digest("hex")
}

let epochFailed = false
let onEpochFailure: (() => void) | undefined

export function configureColdDatabaseEpochFailureHandler(handler: () => void) {
  onEpochFailure = handler
}

export class ColdDatabaseEpochError extends Error {
  constructor() {
    super(
      "Cold worker database incarnation changed or could not be verified; admission remains closed"
    )
    this.name = "ColdDatabaseEpochError"
  }
}

/** Never refresh the trusted launcher pin or clear a failure in the running worker. */
export async function assertColdDatabaseEpoch() {
  if (process.env.LYRASHIELD_COLD_SINGLE_WORKER !== "1") return
  if (epochFailed) throw new ColdDatabaseEpochError()
  const expected = process.env.LYRASHIELD_COLD_DATABASE_EPOCH_SHA256
  let matches = false
  try {
    matches =
      typeof expected === "string" &&
      /^[a-f0-9]{64}$/.test(expected) &&
      (await readColdDatabaseEpochHash()) === expected
  } catch {
    // Query errors carry deployment details; expose only the closed admission state.
  }
  if (!matches || epochFailed) {
    if (!epochFailed) {
      epochFailed = true
      onEpochFailure?.()
    }
    throw new ColdDatabaseEpochError()
  }
}
