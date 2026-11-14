import pg from "pg"
import { z } from "zod"
import { createPgConnectionConfig } from "./connection-config"

const inputSchema = z
  .object({
    authorityEpochId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/),
    epoch: z.number().int().positive().max(2147483647),
    workerInstanceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/),
    workerGrantId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/),
    credentialHash: z.string().regex(/^[a-f0-9]{64}$/),
    operations: z.literal(true).optional(),
    cleanup: z.literal(true).optional(),
    operationId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/)
      .optional(),
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/)
      .optional(),
  })
  .strict()
  .refine(
    (input) =>
      ((!input.operationId && !input.cursor) || input.operations === true) &&
      !(input.operationId && input.cursor)
  )

/** Called only by the fixed root observer image entrypoint with protected env. */
export async function readInstalledWorkerGrant(connectionString: string, value: unknown) {
  if (process.getuid?.() !== 0) throw new Error("Worker observer is unavailable")
  const input = inputSchema.parse(value)
  if (!connectionString) throw new Error("Worker observer connection is unavailable")
  const pool = new pg.Pool({
    ...createPgConnectionConfig(connectionString),
    max: 1,
    connectionTimeoutMillis: 2000,
  })
  try {
    const connection = await pool.connect()
    try {
      await connection.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY")
      await connection.query("SET LOCAL statement_timeout='2s'")
      await connection.query("SELECT app.require_scan_native_origin_reader()")
      const rows = (
        await connection.query(
          input.cleanup
            ? "SELECT * FROM app.read_scan_installed_worker_cleanup_grant($1,$2,$3,$4,$5)"
            : "SELECT * FROM app.read_scan_installed_worker_grant($1,$2,$3,$4,$5)",
          [
            input.authorityEpochId,
            input.epoch,
            input.workerInstanceId,
            input.workerGrantId,
            input.credentialHash,
          ]
        )
      ).rows
      if (
        rows.length !== 1 ||
        !(rows[0]?.expiresAt instanceof Date) ||
        (!input.cleanup && rows[0].expiresAt.getTime() <= Date.now())
      )
        throw new Error("Current worker grant is unavailable")
      const operations = input.operations
        ? z
            .array(
              z
                .object({
                  operationId: z.string().min(1).max(192),
                  workspaceId: z.string().min(1).max(192),
                  scanId: z.string().min(1).max(192),
                  attemptId: z.string().min(1).max(192),
                  state: z.enum([
                    "PREPARING",
                    "PREPARED",
                    "START_PENDING",
                    "ACTIVE",
                    "STOPPING",
                    "UNKNOWN",
                    "TERMINATED",
                  ]),
                })
                .strict()
            )
            .max(32)
            .parse(
              (
                await connection.query(
                  input.cleanup
                    ? "SELECT * FROM app.read_scan_installed_worker_cleanup_operations($1,$2,$3,$4,$5,$6,$7)"
                    : "SELECT * FROM app.read_scan_installed_worker_operations($1,$2,$3,$4,$5,$6,$7)",
                  [
                    input.authorityEpochId,
                    input.epoch,
                    input.workerInstanceId,
                    input.workerGrantId,
                    input.credentialHash,
                    input.operationId ?? null,
                    input.cursor ?? null,
                  ]
                )
              ).rows
            )
        : undefined
      return {
        schema: "lyrashield-root-worker-grant-observation/1",
        current: !input.cleanup,
        ...(input.cleanup ? { cleanup: true } : {}),
        expiresAt: rows[0].expiresAt.toISOString(),
        ...(operations ? { operations } : {}),
      }
    } finally {
      await connection.query("ROLLBACK")
      connection.release()
    }
  } finally {
    await pool.end()
  }
}
