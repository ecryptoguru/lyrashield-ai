import { z } from "zod"
import { loadDatabaseSupervisorAuthority } from "./database-authority"
import { nativeExecutorRequestSchema, NATIVE_REQUEST_BYTES } from "./native-executor-protocol"
import { readNativeHostRequest } from "./native-host-query-read"
import { planNativeHostRequest } from "./native-host-query-plan"

const inputSchema = z
  .object({ request: nativeExecutorRequestSchema, origin: z.unknown().nullable() })
  .strict()
/** Fixed root-owned image entrypoint. Its input is the root socket request, never argv. */
async function main() {
  if (process.getuid?.() !== 0 || process.argv.length !== 2) throw new Error()
  let bytes = Buffer.alloc(0)
  for await (const chunk of process.stdin) {
    bytes = Buffer.concat([bytes, chunk as Buffer])
    if (bytes.length > 512 * 1024 + NATIVE_REQUEST_BYTES) throw new Error()
  }
  const { request, origin } = inputSchema.parse(JSON.parse(bytes.toString("utf8")))
  const installed = loadDatabaseSupervisorAuthority({
    signingSecret: process.env.LYRASHIELD_SUPERVISOR_SIGNING_SECRET!,
    supervisorInstanceId: process.env.LYRASHIELD_SUPERVISOR_INSTANCE_ID!,
    controlToken: process.env.LYRASHIELD_SUPERVISOR_CONTROL_TOKEN!,
  })
  if (!installed) throw new Error()
  const connection = await installed.pool.connect()
  try {
    await connection.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY")
    await connection.query("SET LOCAL statement_timeout = '2s'")
    const retained = await readNativeHostRequest(request, origin, installed, connection)
    if (retained !== undefined) return retained
    if (request.method !== "create" && request.method !== "start" && request.method !== "tool")
      throw new Error()
    return await planNativeHostRequest(request, origin, installed, connection)
  } finally {
    await connection.query("ROLLBACK")
    connection.release()
    await installed.close()
  }
}

main()
  .then((plan) => {
    const raw = JSON.stringify(plan)
    if (Buffer.byteLength(raw) > 512 * 1024) throw new Error()
    process.stdout.write(raw + "\n")
  })
  .catch(() => {
    process.stderr.write("Native action authority unavailable\n")
    process.exitCode = 1
  })
