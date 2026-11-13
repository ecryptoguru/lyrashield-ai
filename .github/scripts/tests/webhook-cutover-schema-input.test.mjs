import assert from "node:assert/strict"
import test from "node:test"
import { assertRuntimeRoleLeastPrivilege } from "../../../ops/worker/webhook-cutover-schema.mjs"

test("runtime role URL parse failures use a fixed sanitized error", async () => {
  const prisma = {
    $queryRawUnsafe: async () => {
      throw new Error("role query must not run for an invalid URL")
    },
  }
  for (const databaseUrl of ["not-a-url", "postgresql://worker%ZZ@db.example/lyra"]) {
    await assert.rejects(
      assertRuntimeRoleLeastPrivilege(prisma, databaseUrl),
      (error) => {
        assert.equal(error.message, "Webhook recovery runtime database identity is invalid")
        assert.equal("input" in error, false)
        return true
      },
    )
  }
})
