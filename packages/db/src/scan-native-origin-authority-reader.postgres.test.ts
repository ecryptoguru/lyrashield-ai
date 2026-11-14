import { readFile } from "node:fs/promises"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  canonicalJson,
  sha256Hex,
  type AuthorityAction,
  type AuthoritySqlConnection,
} from "@lyrashield/runtime-control"
import { createScanDispatchAuthorityBroker } from "./scan-dispatch-authority-broker"
import { createScanExecutionActionAuthorityVerifier } from "./scan-execution-action-intent"
import { createScanExecutionInvocationGuardWriter } from "./scan-execution-invocation-guard"
import { createScanNativeOriginAuthorityVerifier } from "./scan-native-origin-authority-reader"
import { readScanNativeRetainedGuard } from "./scan-native-retained-authority-reader"
import {
  applyPreparationFixtureMigration,
  fixturePreparationCompiler,
  installPreparationFixtureRole,
  preparationFixture,
  preparationInput,
} from "../scripts/tests/scan-preparation-fixture"
import { queueFixtureWorker } from "../scripts/tests/queue-outbox-fixture"
import { installNativeOriginFixtureRole } from "../scripts/tests/native-origin-fixture"

await vi.hoisted(async () => {
  const runtime = process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL
  if (process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1" || !runtime) return
  const { assertDisposableDatabasePair } =
    await import("../../../.github/scripts/vitest-database-env.mjs")
  assertDisposableDatabasePair({ ...process.env, RLS_RUNTIME_DATABASE_URL: runtime })
})

const enabled =
  process.env.SCAN_DISPATCH_AUTHORITY_POSTGRES_TEST === "1" &&
  process.env.LYRASHIELD_TEST_DB_DISPOSABLE === "1"
const queue = queueFixtureWorker()
let owner: pg.Pool, runtime: pg.Pool, reader: pg.Pool
let broker: ReturnType<typeof createScanDispatchAuthorityBroker>
const verifyCurrent = createScanExecutionActionAuthorityVerifier({
  approvedProviderPolicies: new Map(),
})
const verifyOrigin = createScanNativeOriginAuthorityVerifier({
  approvedProviderPolicies: new Map(),
})

describe.skipIf(!enabled)(
  "read-only native origin authority bridge on disposable PostgreSQL",
  () => {
    const preparedSources: Awaited<ReturnType<typeof prepareOriginalSource>>[] = []
    beforeAll(async () => {
      owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 })
      owner.on("error", () => {})
      await queue.open()
      await applyPreparationFixtureMigration(owner)
      await installPreparationFixtureRole(owner)
      for (const [name, query] of [
        [
          "20261114150000_scan_native_guard_backend",
          "SELECT 1 FROM information_schema.columns WHERE table_name='ScanExecutionInvocationGuard' AND column_name='nativeBackendPid'",
        ],
        [
          "20261114160000_scan_native_origin_authority_reader",
          "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname='read_scan_native_origin_guard'",
        ],
        [
          "20261114184000_scan_native_retained_authority_reader",
          "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname='read_scan_native_retained_guard'",
        ],
        [
          "20261114184500_scan_installed_worker_grant_reader",
          "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname='read_scan_installed_worker_grant'",
        ],
        [
          "20261114185500_scan_native_tool_retirement_reader",
          "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname='read_scan_native_pending_tool_guards'",
        ],
        [
          "20261114200000_scan_worker_result_observation_reader",
          "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname='read_scan_installed_worker_operations'",
        ],
      ]) {
        if (!(await owner.query(query)).rowCount) {
          await owner.query(
            await readFile(
              new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url),
              "utf8"
            )
          )
        }
      }
      const readerUrl = await installNativeOriginFixtureRole(owner)
      runtime = new pg.Pool({
        connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL,
        max: 3,
      })
      reader = new pg.Pool({ connectionString: readerUrl, max: 2 })
      runtime.on("error", () => {})
      reader.on("error", () => {})
      broker = createScanDispatchAuthorityBroker({
        connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
        preparationAuthority: "checked-intent-v1",
        compilePreparation: fixturePreparationCompiler,
      })
      const probe = await reader.connect()
      try {
        await probe.query("BEGIN READ ONLY")
        const eligible = (
          await probe.query("SELECT app.scan_native_origin_reader_eligible() AS eligible")
        ).rows[0]?.eligible
        if (eligible !== true) {
          const causes = (
            await probe.query(`SELECT
            current_user AS login,current_setting('transaction_read_only') AS readonly,
            has_database_privilege(session_user,current_database(),'CREATE,TEMPORARY') AS database_write,
            ARRAY(SELECT nspname FROM pg_namespace WHERE has_schema_privilege(session_user,oid,'CREATE')) AS writable_schemas,
            ARRAY(SELECT oid::regclass::text FROM pg_class WHERE relkind IN ('r','p','v','m','f') AND oid<>'pg_catalog.pg_settings'::regclass AND
              (has_table_privilege(session_user,oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(session_user,oid,'INSERT,UPDATE,REFERENCES'))) AS writable_tables,
            ARRAY(SELECT oid::regprocedure::text FROM pg_proc WHERE prosecdef AND has_function_privilege(session_user,oid,'EXECUTE')
              AND oid NOT IN ('app.scan_preparation_context(text)'::regprocedure,'app.scan_native_executor_origin_gate_held(text)'::regprocedure,'app.read_scan_native_origin_guard(text)'::regprocedure)) AS unreviewed_definers`)
          ).rows[0]
          throw new Error(
            `Disposable native reader restriction mismatch: ${JSON.stringify(causes)}`
          )
        }
      } finally {
        await probe.query("ROLLBACK")
        probe.release()
      }
      // Stage source fixtures before any unresolved native guard exists. The
      // guards remain immutable; no synthetic resolution or deletion is used.
      for (let index = 0; index < 4; index += 1)
        preparedSources.push(
          await prepareOriginalSource(index === 3 ? new Date(Date.now() + 8000) : undefined)
        )
    }, 30000)
    afterAll(async () => {
      await broker?.close()
      await runtime?.end()
      await reader?.end()
      await owner?.end()
      await queue.close()
    })

    async function prepareOriginalSource(grantExpiresAt?: Date) {
      const f = await preparationFixture(owner, 1, "native-origin", undefined, false, "RESERVED", {
        grantExpiresAt,
      })
      // Only this owned fixture's normal writer seeds its immutable assignment.
      const assignment = await owner.connect()
      try {
        await assignment.query("BEGIN")
        await assignment.query("SELECT pg_advisory_xact_lock_shared(1819234670,1)")
        await assignment.query(
          'INSERT INTO "ScanDispatchWorkerAssignment"("operationId","workspaceId","workerGrantId","authorityEpochId") VALUES($1,$2,$3,$4)',
          [f.operationId, f.workspaceId, f.grantId, f.epochId]
        )
        await assignment.query("COMMIT")
      } finally {
        assignment.release()
      }
      const prepared = await broker.prepare({
        ...preparationInput(f),
        ...(grantExpiresAt ? { expiresAt: grantExpiresAt } : {}),
      })
      if (prepared.kind !== "committed") throw new Error("Original preparation did not commit")
      const stored = (
        await owner.query(
          'SELECT "commandInputJson","commandInputChecksum" FROM "ScanDispatchOutbox" WHERE id=$1',
          [prepared.commandId]
        )
      ).rows[0]
      const command = JSON.parse(stored.commandInputJson)
      const binding: AuthorityAction = {
        phase: "PREPARE",
        operationId: f.operationId,
        attemptId: prepared.attemptId,
        commandId: prepared.commandId,
        scanId: f.scanId,
        workspaceId: f.workspaceId,
        authorityEpochId: f.epochId,
        authorityRevision: command.attempt.authorityRevision,
        authorityChecksum: sha256Hex(
          canonicalJson({
            attempt: command.attempt,
            executors: command.executors,
            provider: command.provider ?? null,
          })
        ),
        actionChecksum: stored.commandInputChecksum,
      }
      return { f, binding, grantExpiresAt }
    }
    async function originalInvocation(spoofBackendStamp = false) {
      const source = preparedSources.shift()
      if (!source) throw new Error("Pre-staged native source fixture unavailable")
      const { f, binding, grantExpiresAt } = source
      const c = await runtime.connect()
      await c.query("SELECT pg_advisory_lock(1819234670,1)")
      try {
        await c.query("BEGIN")
        const connection: AuthoritySqlConnection = {
          query(text, values = []) {
            if (spoofBackendStamp && text.startsWith('INSERT INTO "ScanExecutionInvocationGuard"'))
              return c.query(
                text
                  .replace(
                    '"bindingInputJson")',
                    '"bindingInputJson","nativeBackendPid","nativeBackendStart")'
                  )
                  .replace("$11,$12,$13)", "$11,$12,$13,$14,$15)"),
                [...values, 0, "1900-01-01T00:00:00Z"]
              )
            return c.query(text, values)
          },
          release() {
            c.release()
          },
        }
        const guard = await createScanExecutionInvocationGuardWriter(verifyCurrent).begin(
          connection,
          binding
        )
        await c.query("COMMIT")
        return { f, binding, guardId: guard.guardId, grantExpiresAt, c }
      } catch (error) {
        await c.query("ROLLBACK")
        await c.query("SELECT pg_advisory_unlock(1819234670,1)")
        c.release()
        throw error
      }
    }
    async function readOriginal(binding: AuthorityAction, guardId: string, readOnly = true) {
      const c = await reader.connect()
      try {
        await c.query(readOnly ? "BEGIN READ ONLY" : "BEGIN READ WRITE")
        return await verifyOrigin(c, binding, guardId)
      } finally {
        await c.query("ROLLBACK")
        c.release()
      }
    }

    it("reuses complete current authority under the exact live originating session gate", async () => {
      const original = await originalInvocation(true)
      try {
        const result = await readOriginal(original.binding, original.guardId)
        expect(result.deadlineAt).toBeInstanceOf(Date)
        const epoch = (
          await owner.query('SELECT epoch FROM "ScanAuthorityEpoch" WHERE id=$1', [
            original.f.epochId,
          ])
        ).rows[0].epoch
        const observer = await reader.connect()
        try {
          await observer.query("BEGIN READ ONLY")
          const input = [
            original.f.epochId,
            epoch,
            original.f.instanceId,
            original.f.grantId,
            sha256Hex(original.f.grantId),
          ]
          const observed = (
            await observer.query(
              "SELECT * FROM app.read_scan_installed_worker_grant($1,$2,$3,$4,$5)",
              input
            )
          ).rows
          expect(observed).toHaveLength(1)
          expect(Object.keys(observed[0])).toEqual(["expiresAt"])
          const operationScope = await observer.query(
            "SELECT * FROM app.read_scan_installed_worker_operations($1,$2,$3,$4,$5,$6,$7)",
            [...input, original.f.operationId, null]
          )
          expect(operationScope.rows).toEqual([
            {
              operationId: original.f.operationId,
              workspaceId: original.f.workspaceId,
              scanId: original.f.scanId,
              attemptId: original.binding.attemptId,
              state: "PREPARING",
            },
          ])
          expect(
            (
              await observer.query(
                "SELECT * FROM app.read_scan_installed_worker_operations($1,$2,$3,$4,$5,$6,$7)",
                [...input, "foreign-operation", null]
              )
            ).rowCount
          ).toBe(0)
          expect(
            (
              await observer.query(
                "SELECT * FROM app.read_scan_installed_worker_operations($1,$2,$3,$4,$5,$6,$7)",
                [...input, null, original.f.operationId]
              )
            ).rowCount
          ).toBe(0)
          for (const bad of [
            [...input.slice(0, 4), "0".repeat(64)],
            [input[0], epoch + 1, ...input.slice(2)],
          ])
            expect(
              (
                await observer.query(
                  "SELECT * FROM app.read_scan_installed_worker_grant($1,$2,$3,$4,$5)",
                  bad
                )
              ).rows
            ).toHaveLength(0)
        } finally {
          await observer.query("ROLLBACK")
          observer.release()
        }
        const stamp = (
          await owner.query(
            'SELECT "nativeBackendPid","nativeBackendStart" FROM "ScanExecutionInvocationGuard" WHERE id=$1',
            [original.guardId]
          )
        ).rows[0]
        const backend = (
          await original.c.query(
            "SELECT pg_backend_pid() pid,backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()"
          )
        ).rows[0]
        expect(stamp.nativeBackendPid).toBe(backend.pid)
        expect(stamp.nativeBackendStart).toEqual(backend.backend_start)
        await expect(
          readOriginal({ ...original.binding, actionChecksum: "0".repeat(64) }, original.guardId)
        ).rejects.toThrow()
        await expect(
          readOriginal(original.binding, `${original.guardId}-missing`)
        ).rejects.toThrow()
        await expect(readOriginal(original.binding, original.guardId, false)).rejects.toThrow(
          /READ ONLY/
        )
      } finally {
        await original.c.query("SELECT pg_advisory_unlock(1819234670,1)")
        original.c.release()
      }
    })

    it("does not accept another backend's global lock after the original session is gone", async () => {
      const original = await originalInvocation()
      original.c.release(true)
      const other = await runtime.connect()
      try {
        await other.query("SELECT pg_advisory_lock(1819234670,1)")
        await expect(readOriginal(original.binding, original.guardId)).rejects.toThrow()
        const observer = await reader.connect()
        try {
          await observer.query("BEGIN READ ONLY")
          expect(
            await readScanNativeRetainedGuard(observer, original.binding, original.guardId)
          ).toEqual(original.binding)
        } finally {
          await observer.query("ROLLBACK")
          observer.release()
        }
      } finally {
        await other.query("SELECT pg_advisory_unlock(1819234670,1)")
        other.release()
      }
    })

    it("denies writers and generic GUC spoofing; the readonly reader cannot change guard or money", async () => {
      const original = await originalInvocation()
      try {
        const writer = await runtime.connect()
        try {
          await writer.query("BEGIN READ ONLY")
          await writer.query("SELECT set_config('app.native_origin_guard_id',$1,true)", [
            original.guardId,
          ])
          await expect(
            writer.query("SELECT app.require_scan_native_origin_reader()")
          ).rejects.toThrow()
        } finally {
          await writer.query("ROLLBACK")
          writer.release()
        }
        for (const statement of [
          'UPDATE "ScanExecutionInvocationGuard" SET "nativeBackendPid"=pg_backend_pid() WHERE id=$1',
          "UPDATE \"BillingAccount\" SET status='canceled' WHERE id=$1",
        ]) {
          const c = await reader.connect()
          try {
            await c.query("BEGIN READ ONLY")
            await expect(c.query(statement, [original.guardId])).rejects.toThrow()
          } finally {
            await c.query("ROLLBACK")
            c.release()
          }
        }
      } finally {
        await original.c.query("SELECT pg_advisory_unlock(1819234670,1)")
        original.c.release()
      }
    })

    it("retains the original finite grant deadline instead of extending it on a root reread", async () => {
      const original = await originalInvocation()
      const expiresAt = original.grantExpiresAt!
      try {
        const result = await readOriginal(original.binding, original.guardId)
        expect(result.deadlineAt.getTime()).toBeLessThanOrEqual(expiresAt.getTime())
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now() + 50))
        )
        await expect(readOriginal(original.binding, original.guardId)).rejects.toThrow()
        const observer = await reader.connect()
        try {
          await observer.query("BEGIN READ ONLY")
          expect(
            await readScanNativeRetainedGuard(observer, original.binding, original.guardId)
          ).toEqual(original.binding)
        } finally {
          await observer.query("ROLLBACK")
          observer.release()
        }
      } finally {
        await original.c.query("SELECT pg_advisory_unlock(1819234670,1)")
        original.c.release()
      }
    }, 15000)
  }
)
