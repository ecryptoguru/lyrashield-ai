import { performance } from "node:perf_hooks"
import { z } from "zod"
import type { AuthoritySqlConnection, AuthoritySqlPool } from "./postgres-mirror"
import { executorKeySchema } from "./protocol"

const id = z
  .string()
  .min(3)
  .max(192)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .refine((value) => !value.includes(".."))
export const authorityActionSchema = z
  .object({
    phase: z.enum([
      "PREPARE",
      "EXECUTOR_CREATE",
      "EXECUTOR_START",
      "PROVIDER_DISPATCH",
      "SANDBOX_TOOL",
    ]),
    operationId: id,
    attemptId: id,
    scanId: id,
    workspaceId: id,
    authorityEpochId: id,
    authorityRevision: z.number().int().nonnegative().safe(),
    authorityChecksum: z.string().regex(/^[a-f0-9]{64}$/),
    actionChecksum: z.string().regex(/^[a-f0-9]{64}$/),
    commandId: id.optional(),
    executorKey: executorKeySchema.optional(),
    requestId: id.optional(),
  })
  .strict()
  .refine((value) =>
    value.phase === "PROVIDER_DISPATCH"
      ? value.requestId !== undefined &&
        value.commandId === undefined &&
        value.executorKey === undefined
      : value.phase === "SANDBOX_TOOL"
        ? value.requestId !== undefined &&
          value.commandId !== undefined &&
          value.executorKey === "sandbox"
        : value.commandId !== undefined &&
          value.requestId === undefined &&
          (value.phase === "PREPARE"
            ? value.executorKey === undefined
            : value.executorKey !== undefined)
  )
export type AuthorityAction = z.infer<typeof authorityActionSchema>

export interface ScanAuthorityFence {
  run<T>(
    binding: AuthorityAction,
    effect: (assertActive: () => void, invocation?: { guardId: string }) => T | Promise<T>
  ): Promise<T>
}

export class AuthorityFenceError extends Error {
  constructor() {
    super("Current scan execution authority is unavailable")
    this.name = "AuthorityFenceError"
  }
}

/** The verifier uses this same restricted connection to read persisted authority. */
export type VerifyActionAuthority = (
  connection: AuthoritySqlConnection,
  binding: AuthorityAction
) => Promise<{ deadlineAt: Date }>

/** Shares the existing database writer gate; never retries an invoked effect. */
export class PostgresScanAuthorityFence implements ScanAuthorityFence {
  constructor(
    private readonly pool: AuthoritySqlPool,
    private readonly verify: VerifyActionAuthority
  ) {}

  async run<T>(
    input: AuthorityAction,
    effect: (assertActive: () => void) => T | Promise<T>
  ): Promise<T> {
    const binding = Object.freeze(authorityActionSchema.parse(input))
    let connection: AuthoritySqlConnection | undefined
    let failed = true
    let active = true
    let deadlineMs = performance.now() + 10_000
    let timer: ReturnType<typeof setTimeout> | undefined
    const assertActive = () => {
      if (!active || performance.now() >= deadlineMs) throw new AuthorityFenceError()
    }
    let rejectExpired: (error: Error) => void = () => undefined
    const expired = new Promise<never>((_, reject) => {
      rejectExpired = reject
    })
    const armDeadline = () => {
      clearTimeout(timer)
      timer = setTimeout(
        () => {
          active = false
          rejectExpired(new AuthorityFenceError())
        },
        Math.max(0, deadlineMs - performance.now())
      )
    }
    armDeadline()
    const lostConnection = () => {
      active = false
      rejectExpired(new AuthorityFenceError())
    }
    const work = async () => {
      const acquiredConnection = await this.pool.connect()
      if (!active || performance.now() >= deadlineMs) {
        acquiredConnection.release(true)
        throw new AuthorityFenceError()
      }
      connection = acquiredConnection
      if (!acquiredConnection.on || !acquiredConnection.off) throw new AuthorityFenceError()
      acquiredConnection.on("error", lostConnection)
      acquiredConnection.on("end", lostConnection)
      const checkedConnection: AuthoritySqlConnection = {
        query: async (text, values) => {
          assertActive()
          const result = await acquiredConnection.query(text, values)
          assertActive()
          return result
        },
        release: () => {
          throw new AuthorityFenceError()
        },
      }
      await checkedConnection.query("BEGIN ISOLATION LEVEL READ COMMITTED", [])
      await checkedConnection.query("SET LOCAL idle_in_transaction_session_timeout = '10s'", [])
      const acquired = await checkedConnection.query(
        "SELECT app.acquire_scan_preparation_gate() AS acquired",
        []
      )
      if (acquired.rows.length !== 1 || acquired.rows[0]?.acquired !== true)
        throw new AuthorityFenceError()
      const checked = await this.verify(checkedConnection, binding)
      if (!(checked.deadlineAt instanceof Date) || !Number.isFinite(checked.deadlineAt.getTime()))
        throw new AuthorityFenceError()
      const beforeReadMs = performance.now()
      const proof = await checkedConnection.query(
        'SELECT app.scan_preparation_gate_held() AS held, ceil(extract(epoch FROM clock_timestamp()) * 1000)::text AS "nowMs"',
        []
      )
      const row = proof.rows[0]
      if (
        proof.rows.length !== 1 ||
        row?.held !== true ||
        typeof row.nowMs !== "string" ||
        !/^[0-9]{13,16}$/.test(row.nowMs)
      )
        throw new AuthorityFenceError()
      const databaseNowMs = Number(row.nowMs)
      if (!Number.isSafeInteger(databaseNowMs)) throw new AuthorityFenceError()
      deadlineMs = Math.min(deadlineMs, beforeReadMs + checked.deadlineAt.getTime() - databaseNowMs)
      assertActive()
      armDeadline()
      const result = await effect(assertActive)
      // Read-only verification still retains the native transaction through invocation.
      assertActive()
      await checkedConnection.query("ROLLBACK", [])
      failed = false
      return result
    }
    try {
      return await Promise.race([work(), expired])
    } finally {
      active = false
      clearTimeout(timer)
      if (!failed) {
        connection?.off?.("error", lostConnection)
        connection?.off?.("end", lostConnection)
      }
      // Destroy failed sessions instead of waiting on an uncertain rollback.
      connection?.release(failed)
    }
  }
}
