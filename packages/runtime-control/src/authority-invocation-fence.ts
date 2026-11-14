import { performance } from "node:perf_hooks"
import {
  AuthorityFenceError,
  authorityActionSchema,
  type AuthorityAction,
  type ScanAuthorityFence,
  type VerifyActionAuthority,
} from "./authority-fence"
import type { AuthoritySqlConnection, AuthoritySqlPool } from "./postgres-mirror"
import { ScanAuthorityContext } from "./authority-context"

export interface ScanInvocationGuardWriter {
  begin(connection: AuthoritySqlConnection, binding: AuthorityAction): Promise<{ guardId: string }>
  verifyCommitted(
    connection: AuthoritySqlConnection,
    binding: AuthorityAction,
    guardId: string
  ): Promise<void>
}

/**
 * A committed guard survives session loss. Writers must reject an unresolved
 * guard; only authenticated original physical evidence may resolve it.
 */
export class PostgresDurableScanAuthorityFence implements ScanAuthorityFence {
  constructor(
    private readonly pool: AuthoritySqlPool,
    private readonly verify: VerifyActionAuthority,
    private readonly guard: ScanInvocationGuardWriter,
    private readonly context = new ScanAuthorityContext()
  ) {}

  async run<T>(
    input: AuthorityAction,
    effect: (assertActive: () => void, invocation?: { guardId: string }) => T | Promise<T>
  ): Promise<T> {
    const binding = Object.freeze(authorityActionSchema.parse(input))
    let connection: AuthoritySqlConnection | undefined
    let failed = true
    let active = true
    let deadlineMs = performance.now() + 10_000
    let timer: ReturnType<typeof setTimeout> | undefined
    let rejectExpired: (error: Error) => void = () => undefined
    const expired = new Promise<never>((_, reject) => {
      rejectExpired = reject
    })
    const assertActive = () => {
      if (!active || performance.now() >= deadlineMs) throw new AuthorityFenceError()
    }
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
    const lostConnection = () => {
      active = false
      rejectExpired(new AuthorityFenceError())
    }
    armDeadline()
    const work = async () => {
      const acquiredConnection = await this.pool.connect()
      if (!active || performance.now() >= deadlineMs) {
        acquiredConnection.release(true)
        throw new AuthorityFenceError()
      }
      connection = acquiredConnection
      if (!connection.on || !connection.off) throw new AuthorityFenceError()
      connection.on("error", lostConnection)
      connection.on("end", lostConnection)
      const checked: AuthoritySqlConnection = {
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
      const clean = await checked.query(
        "SELECT NOT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory' AND pid=pg_catalog.pg_backend_pid() AND classid=1819234670 AND objid=1 AND objsubid=2 AND granted) AS clean",
        []
      )
      if (clean.rows.length !== 1 || clean.rows[0]?.clean !== true) throw new AuthorityFenceError()
      const locked = await checked.query(
        "SELECT pg_catalog.pg_try_advisory_lock(1819234670,1) AS acquired",
        []
      )
      if (locked.rows.length !== 1 || locked.rows[0]?.acquired !== true)
        throw new AuthorityFenceError()
      await checked.query("BEGIN ISOLATION LEVEL READ COMMITTED", [])
      await checked.query("SET LOCAL idle_in_transaction_session_timeout = '10s'", [])
      const { guardId } = await this.guard.begin(checked, binding)
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/.test(guardId)) throw new AuthorityFenceError()
      // A lost COMMIT acknowledgement never permits invocation. The guard may
      // nevertheless have committed and is held for original reconciliation.
      await checked.query("COMMIT", [])
      await checked.query("BEGIN ISOLATION LEVEL READ COMMITTED", [])
      await checked.query("SET LOCAL idle_in_transaction_session_timeout = '10s'", [])
      const authority = await this.verify(checked, binding)
      await this.guard.verifyCommitted(checked, binding, guardId)
      if (
        !(authority.deadlineAt instanceof Date) ||
        !Number.isFinite(authority.deadlineAt.getTime())
      )
        throw new AuthorityFenceError()
      const beforeReadMs = performance.now()
      const proof = await checked.query(
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
      const nowMs = Number(row.nowMs)
      if (!Number.isSafeInteger(nowMs)) throw new AuthorityFenceError()
      deadlineMs = Math.min(deadlineMs, beforeReadMs + authority.deadlineAt.getTime() - nowMs)
      assertActive()
      armDeadline()
      await checked.query("COMMIT", [])
      const result = await this.context.run(
        { connection: checked, binding, guardId, assertActive },
        () => effect(assertActive, { guardId })
      )
      assertActive()
      const unlocked = await checked.query(
        "SELECT pg_catalog.pg_advisory_unlock(1819234670,1) AS unlocked",
        []
      )
      if (unlocked.rows.length !== 1 || unlocked.rows[0]?.unlocked !== true)
        throw new AuthorityFenceError()
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
      // Destroy any session with uncertain lock, commit or action outcome.
      connection?.release(failed)
    }
  }
}
