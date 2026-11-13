import { createBoundedPgAdapter } from "@lyrashield/db"
import { PrismaClient } from "@lyrashield/db/src/generated/prisma"
import { env } from "@lyrashield/config"
import { readColdDatabaseEpochHash } from "../cold-database-epoch"

/** Trusted launcher only: use the candidate's runtime connection, return only the public epoch hash. */
export async function captureColdDatabaseEpoch(): Promise<string> {
  try {
    const client = new PrismaClient({
      adapter: createBoundedPgAdapter(env.DATABASE_URL),
      log: [],
    })
    try {
      return await readColdDatabaseEpochHash(client)
    } finally {
      await client.$disconnect()
    }
  } catch {
    throw new Error("Cold database epoch capture unavailable")
  }
}
