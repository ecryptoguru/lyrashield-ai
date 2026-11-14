import { isAbsolute } from "node:path"
import pg from "pg"
import { createPgConnectionConfig } from "@lyrashield/db/src/connection-config"
import { createNativeSupervisorReceiptConsumer } from "@lyrashield/db/src/scan-dispatch-authority-broker"
import { createScanSupervisorJournalAuthority } from "@lyrashield/db/src/scan-supervisor-journal-authority"
import { createConfiguredJournalStore, PostgresAuthorityMirror } from "@lyrashield/runtime-control"
import type { SupervisorConfig } from "./config"
import { bindingFor } from "./authority-bindings"
import { createSupervisorAuthorityJournal } from "./authority-journal"
import type { loadDatabaseSupervisorAuthority } from "./database-authority"
import { createInstalledSupervisorToolJournal } from "./installed-tool-journal"

function unavailable(): never {
  throw new Error("Protected independent supervisor journal is unavailable")
}

/** Packaged loader uses distinct protected credentials; closed legacy startup stays available. */
export async function loadInstalledSupervisorJournal(
  config: SupervisorConfig,
  authority: ReturnType<typeof loadDatabaseSupervisorAuthority>,
  env: NodeJS.ProcessEnv = process.env,
  purpose: { purpose: "authority" | "publication" } = { purpose: "authority" }
) {
  const publishes = purpose.purpose === "publication"
  const path = env.LYRASHIELD_SUPERVISOR_INDEPENDENT_JOURNAL_PATH?.trim()
  const mirrorUrl = env.LYRASHIELD_SUPERVISOR_MIRROR_DATABASE_URL?.trim()
  const receiptUrl = env.LYRASHIELD_SUPERVISOR_RECEIPT_DATABASE_URL?.trim()
  const storageJson = env.LYRASHIELD_SUPERVISOR_JOURNAL_STORAGE_JSON?.trim()
  if (!path && !mirrorUrl && !storageJson && !receiptUrl) return undefined
  if (
    !authority ||
    !path ||
    !isAbsolute(path) ||
    !mirrorUrl ||
    !storageJson ||
    (!publishes && !receiptUrl)
  )
    unavailable()
  let mirrorRole: string
  try {
    const url = new URL(mirrorUrl),
      execution = new URL(authority.supervisorAuthority.connectionString)
    const receipt = receiptUrl ? new URL(receiptUrl) : undefined
    mirrorRole = decodeURIComponent(url.username)
    if (
      !/^postgres(?:ql)?:$/.test(url.protocol) ||
      !/^[a-z][a-z0-9_]{2,62}$/.test(mirrorRole) ||
      ["postgres", "service_role", "app_runtime_prod", "app_system_prod"].includes(mirrorRole) ||
      decodeURIComponent(execution.username) === mirrorRole ||
      url.hostname !== execution.hostname ||
      (url.port || "5432") !== (execution.port || "5432") ||
      url.pathname !== execution.pathname ||
      (receipt !== undefined &&
        (!/^postgres(?:ql)?:$/.test(receipt.protocol) ||
          !/^[a-z][a-z0-9_]{2,62}$/.test(decodeURIComponent(receipt.username)) ||
          [
            mirrorRole,
            decodeURIComponent(execution.username),
            "postgres",
            "service_role",
            "app_runtime_prod",
            "app_system_prod",
          ].includes(decodeURIComponent(receipt.username)) ||
          receipt.hostname !== execution.hostname ||
          (receipt.port || "5432") !== (execution.port || "5432") ||
          receipt.pathname !== execution.pathname))
    )
      unavailable()
  } catch {
    unavailable()
  }
  const pool = new pg.Pool({
    ...createPgConnectionConfig(mirrorUrl),
    max: 2,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    idleTimeoutMillis: 10000,
  })
  let receipts: ReturnType<typeof createNativeSupervisorReceiptConsumer> | undefined
  let storage: ReturnType<typeof createConfiguredJournalStore> | undefined
  let tools: Promise<Awaited<ReturnType<typeof createInstalledSupervisorToolJournal>>> | undefined
  try {
    const proof = await pool.query(
      `SELECT current_user=$1 AND session_user=$1 AND r.rolcanlogin
      AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb)
      AND has_schema_privilege(current_user,'lyrashield_authority','USAGE')
      AND has_schema_privilege(current_user,'app','USAGE')
      AND has_function_privilege(current_user,'app.scan_supervisor_journal_stream_matches(text,text,text,text,text)','EXECUTE')
      AND has_function_privilege(current_user,'lyrashield_authority.read_head(text,text)','EXECUTE')
      AND has_function_privilege(current_user,'lyrashield_authority.read_record(text,text,bigint)','EXECUTE')
      AND has_function_privilege(current_user,'lyrashield_authority.append_record(text,text,text,text,text)','EXECUTE')
      AND NOT EXISTS(SELECT 1 FROM pg_roles reachable WHERE pg_has_role(current_user,reachable.oid,'SET')
        AND (reachable.rolsuper OR reachable.rolbypassrls OR reachable.rolcreaterole OR reachable.rolcreatedb
          OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
            AND has_schema_privilege(reachable.oid,n.oid,'CREATE'))
          OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname IN ('public','lyrashield_authority') AND c.relkind IN ('r','p','v','m','f')
              AND has_table_privilege(reachable.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')))) AS safe
      FROM pg_roles r WHERE r.rolname=current_user`,
      [mirrorRole]
    )
    if (proof.rows.length !== 1 || proof.rows[0]?.safe !== true) unavailable()
    const identity = authority.supervisorAuthority
    const mirror = new PostgresAuthorityMirror(
      pool,
      identity.authorityEpochId,
      identity.supervisorInstanceId
    )
    storage = createConfiguredJournalStore(storageJson)
    const validators = createScanSupervisorJournalAuthority({
      pool: authority.pool,
      context: authority.context,
      identity,
      mirror,
    })
    const built = createSupervisorAuthorityJournal({
      ...validators,
      readOnly: publishes,
      ...(!publishes
        ? {
            onConfirmed: async (record) => {
              // Native ACK append runs inside its existing checked session gate. The
              // next outside-fence event projects it with separate receipt credentials.
              if (authority.context.current()) return
              if (!receipts) unavailable()
              const history = await built.journal.load()
              const binding = bindingFor(record, history)
              await receipts.consume(binding.operationId)
            },
          }
        : { authorize: async () => false, authorizeRecovery: async () => false }),
      store: storage.store,
      mirror,
      epochId: identity.authorityEpochId,
      supervisorInstanceId: identity.supervisorInstanceId,
      originalPath: config.journalPath,
      independentPath: path,
      originalSigningSecret: identity.originalSigningSecret,
      signingSecret: identity.wrapperSigningSecret,
    })
    if (!publishes)
      receipts = createNativeSupervisorReceiptConsumer({
        ...identity,
        connectionString: receiptUrl!,
        readJournal: (cursor) => built.journal.readCursor(cursor),
      })
    return {
      journal: built.journal,
      consumeReceipts: receipts?.consume,
      createTools: () => {
        tools ??= createInstalledSupervisorToolJournal({
          pool: authority.pool,
          mirrorPool: pool,
          context: authority.context,
          controller: identity,
          mainJournal: built.journal,
          originalPath: config.journalPath,
          independentPath: path,
          storageJson,
          readOnly: publishes,
        })
        return tools
      },
      close: async () => {
        if (tools)
          await tools.then(
            (installed) => installed.close(),
            () => undefined
          )
        await receipts?.close()
        await built.close()
        storage?.close()
        await pool.end()
      },
    }
  } catch {
    await receipts?.close()
    storage?.close()
    await pool.end()
    unavailable()
  }
}
