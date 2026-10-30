// Diagnostic only. Even a complete database snapshot cannot prove an executor
// stopped, either BullMQ queue drained, or that a collector could see all rows.
// This function never authorizes a migration, admission release or replay.
const LIMIT = 10_000
const ACTIVE = new Set(["QUEUED", "PREFLIGHT", "RUNNING", "VERIFYING", "REQUIRES_APPROVAL"])
const TERMINAL = new Set([
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
  "STOPPED_BUDGET",
  "TIMED_OUT",
])
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const id = (value) => typeof value === "string" && value.length > 0 && value.length <= 512
const timestamp = (value) => {
  if (value === null) return true
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
    return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

function emptyResult() {
  return {
    status: "REVIEW_REQUIRED",
    cutoverReady: false,
    historyDispositionComplete: false,
    counts: {
      malformedSnapshot: 0,
      activeScans: 0,
      unfinishedFinalizations: 0,
      malformedScans: 0,
      malformedIntents: 0,
      unsettledIntents: 0,
      unboundReceipts: 0,
      failedScanReceipts: 0,
      receiptWithoutIntent: 0,
      orphanHistoryReceipts: 0,
      unknownDisposition: 0,
      settledReceipts: 0,
    },
  }
}

/**
 * Consume a complete, bounded snapshot privately. IDs and raw metadata are
 * intentionally never included in the result. A caller must independently
 * establish collector visibility, transaction consistency and completeness;
 * the `complete` marker alone is not proof of any of those properties.
 *
 * Legacy scans have no reliable universal accounting-settled timestamp.
 * An absent intent or receipt is classified as unknown, not as a debt or as
 * nonbillable. A positive match follows the account/workspace/scan/key checks
 * used by readAgentMinuteReceipt and does not certify provider accounting.
 */
export function diagnoseLegacyAccountingSnapshot(snapshot) {
  const result = emptyResult()
  const counts = result.counts
  if (
    !object(snapshot) ||
    snapshot.complete !== true ||
    ![snapshot.scans, snapshot.intents, snapshot.receipts].every(
      (rows) => Array.isArray(rows) && rows.length <= LIMIT
    )
  ) {
    counts.malformedSnapshot = 1
    return result
  }

  const scans = new Map()
  for (const scan of snapshot.scans) {
    if (
      !object(scan) ||
      !id(scan.id) ||
      !id(scan.workspaceId) ||
      !id(scan.createdById) ||
      !(scan.sponsorAccountId === null || id(scan.sponsorAccountId)) ||
      ![scan.startedAt, scan.endedAt, scan.finalizationStartedAt].every(timestamp) ||
      (!ACTIVE.has(scan.status) && !TERMINAL.has(scan.status)) ||
      (TERMINAL.has(scan.status) && scan.endedAt === null) ||
      (scan.startedAt !== null && scan.endedAt !== null && scan.startedAt > scan.endedAt) ||
      scans.has(scan.id)
    ) {
      counts.malformedScans++
      continue
    }
    scans.set(scan.id, scan)
    if (ACTIVE.has(scan.status)) {
      counts.activeScans++
      if (scan.finalizationStartedAt !== null) counts.unfinishedFinalizations++
    }
  }

  // A unique receipt key is enforced by PostgreSQL; duplicate snapshot rows
  // indicate an untrustworthy or incompletely understood collector result.
  const receipts = new Map()
  const receiptRows = []
  const expectedScanKeys = new Map(
    [...scans.values()].map((scan) => [`${scan.workspaceId}:${scan.id}:engine_run`, scan])
  )
  for (const receipt of snapshot.receipts) {
    if (!object(receipt)) {
      counts.malformedSnapshot++
      continue
    }
    if (id(receipt.idempotencyKey)) {
      if (receipts.has(receipt.idempotencyKey)) {
        counts.malformedSnapshot++
        continue
      }
      receipts.set(receipt.idempotencyKey, receipt)
    }
    receiptRows.push(receipt)
  }

  const matchedScans = new Set()
  const checkedIntents = new Set()
  const matchedReceipts = new Set()
  for (const intent of snapshot.intents) {
    const scan = object(intent) && id(intent.scanId) ? scans.get(intent.scanId) : undefined
    const metadata = object(intent?.metadata) ? intent.metadata : null
    const account = scan?.sponsorAccountId ?? scan?.createdById
    const expectedKey = scan ? `${scan.workspaceId}:${scan.id}:engine_run` : null
    if (
      !scan ||
      !metadata ||
      metadata.workspaceId !== scan.workspaceId ||
      metadata.accountId !== account ||
      metadata.idempotencyKey !== expectedKey ||
      metadata.automaticReplayAllowed !== false
    ) {
      counts.malformedIntents++
      continue
    }
    if (checkedIntents.has(expectedKey)) continue
    checkedIntents.add(expectedKey)
    const receipt = receipts.get(expectedKey)
    if (
      !object(receipt) ||
      receipt.idempotencyKey !== expectedKey ||
      receipt.kind !== "agent_minutes" ||
      receipt.deletedAt !== null ||
      receipt.workspaceId !== scan.workspaceId ||
      receipt.accountId !== account ||
      !object(receipt.metadata) ||
      receipt.metadata.scanId !== scan.id ||
      receipt.metadata.accountId !== account
    ) {
      counts.unsettledIntents++
      continue
    }
    matchedScans.add(scan.id)
    matchedReceipts.add(expectedKey)
    counts.settledReceipts++
    if (scan.status === "FAILED") counts.failedScanReceipts++
  }

  for (const receipt of receiptRows) {
    const key = receipt.idempotencyKey
    if (id(key) && matchedReceipts.has(key)) continue
    const scanFromMetadata = object(receipt.metadata)
      ? scans.get(receipt.metadata.scanId)
      : undefined
    const scan = scanFromMetadata ?? expectedScanKeys.get(key)
    const account = scan?.sponsorAccountId ?? scan?.createdById
    if (
      scan &&
      !checkedIntents.has(key) &&
      key === `${scan.workspaceId}:${scan.id}:engine_run` &&
      receipt.kind === "agent_minutes" &&
      receipt.deletedAt === null &&
      receipt.workspaceId === scan.workspaceId &&
      receipt.accountId === account &&
      object(receipt.metadata) &&
      receipt.metadata.scanId === scan.id &&
      receipt.metadata.accountId === account
    ) {
      // Cancellation could have a receipt without the finalization intent.
      // Preserve it as incomplete evidence, not proof of debt or release.
      counts.receiptWithoutIntent++
      if (scan.status === "FAILED") counts.failedScanReceipts++
    } else if (!scan && receipt.kind === "agent_minutes" && !checkedIntents.has(key)) {
      // Account-owned history survives hard deletion of its attributed scan
      // and workspace, so missing references alone do not establish a debt.
      counts.orphanHistoryReceipts++
    } else counts.unboundReceipts++
  }
  for (const scan of scans.values()) {
    if (TERMINAL.has(scan.status) && !matchedScans.has(scan.id)) counts.unknownDisposition++
  }
  const hasBlocker = Object.entries(counts).some(
    ([key, value]) =>
      key !== "unknownDisposition" &&
      key !== "settledReceipts" &&
      key !== "receiptWithoutIntent" &&
      key !== "orphanHistoryReceipts" &&
      value > 0
  )
  // Missing historical intent is not by itself an unsettled debt. Preserve
  // that uncertainty explicitly without inventing a charge or blocking on a
  // legacy marker that never existed; this remains a non-authorizing report.
  result.historyDispositionComplete =
    counts.unknownDisposition === 0 &&
    counts.malformedSnapshot === 0 &&
    counts.malformedScans === 0 &&
    counts.malformedIntents === 0 &&
    counts.unboundReceipts === 0 &&
    counts.orphanHistoryReceipts === 0
  result.status = hasBlocker ? "REVIEW_REQUIRED" : "NO_DETECTED_DB_BLOCKERS"
  return result
}

const REQUIRED_COLUMNS = {
  Scan: {
    id: "text",
    workspaceId: "text",
    createdById: "text",
    sponsorAccountId: "text",
    status: "ScanStatus",
    startedAt: "timestamp",
    endedAt: "timestamp",
    finalizationStartedAt: "timestamp",
    deletedAt: "timestamp",
  },
  ScanEvent: {
    id: "text",
    scanId: "text",
    stage: "text",
    metadata: "jsonb",
    deletedAt: "timestamp",
  },
  UsageRecord: {
    id: "text",
    workspaceId: "text",
    accountId: "text",
    kind: "text",
    idempotencyKey: "text",
    deletedAt: "timestamp",
    metadata: "jsonb",
  },
}

/**
 * Collect the pre-v26 inventory with a dedicated, already connected, idle pg
 * client. The caller must bind this connection to the migration database and
 * separately prove admission, writers, queues and process stop. Runtime roles
 * must remain NOBYPASSRLS; this privileged read-only collector requires a
 * separately authorized role that can see all forced-RLS rows.
 *
 * All errors, including incomplete schema, unavailable privilege, timeouts,
 * truncation and rollback failure return the same bounded failure, never raw
 * connection data, private identities, SQL errors or provider amounts.
 */
export async function collectLegacyAccountingDiagnostic(client) {
  const failure = emptyResult()
  failure.counts.malformedSnapshot = 1
  if (!client || typeof client.query !== "function") return failure
  let result = failure
  let began = false
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
    began = true
    await client.query("SET LOCAL statement_timeout = '10s'")
    await client.query("SET LOCAL lock_timeout = '2s'")
    await client.query("SET LOCAL row_security = off")
    const principal = await client.query(`
      SELECT r.rolsuper, r.rolbypassrls,
             current_setting('transaction_read_only') AS read_only,
             current_setting('transaction_isolation') AS isolation,
             current_setting('row_security') AS row_security
      FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`)
    const role = principal.rows?.[0]
    if (
      principal.rows?.length !== 1 ||
      !(role.rolsuper === true || role.rolbypassrls === true) ||
      role.read_only !== "on" ||
      role.isolation !== "repeatable read" ||
      role.row_security !== "off"
    )
      return failure

    const catalog = await client.query(`
      SELECT c.relname AS table_name, a.attname AS column_name, t.typname AS type_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
      JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
      WHERE n.nspname = 'public' AND c.relname IN ('Scan','ScanEvent','UsageRecord')
        AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped`)
    const columns = new Map(
      catalog.rows.map((row) => [`${row.table_name}.${row.column_name}`, row.type_name])
    )
    for (const [table, fields] of Object.entries(REQUIRED_COLUMNS)) {
      for (const [column, type] of Object.entries(fields)) {
        if (columns.get(`${table}.${column}`) !== type) return failure
      }
    }
    // This collector is deliberately legacy-only. A partially or fully
    // migrated schema requires the reservation/slot accounting inventory too.
    if (columns.has("Scan.accountingVersion") || columns.has("Scan.accountingSettledAt"))
      return failure
    const newTables = await client.query(`
      SELECT pg_catalog.to_regclass('public."UserScanSlot"') IS NOT NULL AS slot_present,
             pg_catalog.to_regclass('public."ScanCapacityReservation"') IS NOT NULL AS reservation_present`)
    if (
      newTables.rows?.length !== 1 ||
      newTables.rows[0]?.slot_present !== false ||
      newTables.rows[0]?.reservation_present !== false
    )
      return failure

    const scans = await client.query(
      `
      SELECT left(s.id, 513) AS id, left(s."workspaceId", 513) AS "workspaceId",
        left(s."createdById", 513) AS "createdById", left(s."sponsorAccountId", 513) AS "sponsorAccountId", s.status::text,
        to_char(s."startedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startedAt",
        to_char(s."endedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "endedAt",
        to_char(s."finalizationStartedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "finalizationStartedAt"
      FROM public."Scan" s ORDER BY s.id LIMIT $1`,
      [LIMIT + 1]
    )
    if (scans.rows.length > LIMIT) return failure

    // Include deleted scans and events: soft deletion is not evidence that a
    // monetary obligation or a running executor stopped existing.
    const intents = await client.query(
      `
      SELECT left(e."scanId", 513) AS "scanId",
        CASE WHEN jsonb_typeof(e.metadata) = 'object' THEN jsonb_build_object(
          'workspaceId', CASE WHEN jsonb_typeof(e.metadata -> 'workspaceId') = 'string' THEN left(e.metadata ->> 'workspaceId', 513) END,
          'accountId', CASE WHEN jsonb_typeof(e.metadata -> 'accountId') = 'string' THEN left(e.metadata ->> 'accountId', 513) END,
          'idempotencyKey', CASE WHEN jsonb_typeof(e.metadata -> 'idempotencyKey') = 'string' THEN left(e.metadata ->> 'idempotencyKey', 513) END,
          'automaticReplayAllowed', CASE WHEN jsonb_typeof(e.metadata -> 'automaticReplayAllowed') = 'boolean' THEN e.metadata -> 'automaticReplayAllowed' END
        ) ELSE NULL END AS metadata FROM public."ScanEvent" e
      WHERE e.stage = 'billing_settlement_intent' ORDER BY e.id LIMIT $1`,
      [LIMIT + 1]
    )
    if (intents.rows.length > LIMIT) return failure
    const intentKeys = intents.rows.flatMap(({ metadata }) =>
      object(metadata) && id(metadata.idempotencyKey) ? [metadata.idempotencyKey] : []
    )
    // A conflicting non-agent row can occupy a scan's canonical key even
    // before an intent was recorded. Keep those collisions in the inventory.
    const expectedScanKeys = scans.rows.map((scan) => `${scan.workspaceId}:${scan.id}:engine_run`)
    const receiptKeys = [...new Set([...intentKeys, ...expectedScanKeys])]
    const receipts = await client.query(
      `
      SELECT left(u."workspaceId", 513) AS "workspaceId", left(u."accountId", 513) AS "accountId",
        left(u."idempotencyKey", 513) AS "idempotencyKey", left(u.kind, 513) AS kind,
        to_char(u."deletedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "deletedAt",
        CASE WHEN jsonb_typeof(u.metadata) = 'object' THEN jsonb_build_object(
          'scanId', CASE WHEN jsonb_typeof(u.metadata -> 'scanId') = 'string' THEN left(u.metadata ->> 'scanId', 513) END,
          'accountId', CASE WHEN jsonb_typeof(u.metadata -> 'accountId') = 'string' THEN left(u.metadata ->> 'accountId', 513) END
        ) ELSE NULL END AS metadata
      FROM public."UsageRecord" u
      WHERE u.kind = 'agent_minutes' OR u."idempotencyKey" = ANY($1::text[])
      ORDER BY u.id LIMIT $2`,
      [receiptKeys, LIMIT + 1]
    )
    if (receipts.rows.length > LIMIT) return failure
    result = diagnoseLegacyAccountingSnapshot({
      complete: true,
      scans: scans.rows,
      intents: intents.rows,
      receipts: receipts.rows,
    })
  } catch {
    result = failure
  } finally {
    if (began) {
      try {
        await client.query("ROLLBACK")
      } catch {
        result = failure
      }
    }
  }
  return result
}
