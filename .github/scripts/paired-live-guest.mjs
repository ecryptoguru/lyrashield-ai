// Isolated tools execute inside the pinned worker image, using the existing
// worker authority and no Docker socket. Only finite RPC operations are admitted.
import { createRequire } from "node:module"
import { createHash, randomBytes } from "node:crypto"
import {
  pairedReleaseReceipt,
  OWNED_HOLD_LUA,
  SCAN_ADMISSION_KEY,
} from "../../ops/monitoring/paired-release-hold.mjs"
import { rebindLua, observeLua, armedReleaseLua } from "./paired-runtime-authority.mjs"
import { holdStateLua, assertPairedWorkDrained } from "./paired-runtime-hold.mjs"
import { observeRuntimeDatabase } from "./v26-runtime-database.mjs"

const base = createRequire("/app/apps/worker/package.json")
const dbRequire = createRequire(base.resolve("@lyrashield/db")),
  integrationRequire = createRequire(base.resolve("@lyrashield/integrations"))
const Redis = integrationRequire("ioredis"),
  { Client } = dbRequire("pg")
const hash = (s) => createHash("sha256").update(s).digest("hex")
function check(c) {
  if (!c) throw new Error("Guest proof unavailable")
}
function receipt(raw) {
  check(typeof raw === "string" && raw.length <= 512)
  const r = JSON.parse(raw)
  check(raw === pairedReleaseReceipt(r.owner, r.productRevision, r.engineRevision, r.workerDigest))
  return raw
}
function id(v) {
  check(typeof v === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(v))
  return v
}
async function connected(global, fn) {
  const url = global ? process.env.DATABASE_SYSTEM_URL : process.env.DATABASE_URL
  check(url)
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 6000,
    statement_timeout: 8000,
  })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}
// Called INSIDE the same read-only system transaction that performs the
// global query. The advisory challenge also distinguishes cloned databases
// with matching catalog/server fingerprints and transaction-pool endpoints.
async function bindGlobalSession(system) {
  check(hash(process.env.DATABASE_URL) === process.env.PAIRED_RUNTIME_DB_HASH)
  await connected(false, async (runtime) => {
    await runtime.query("BEGIN READ ONLY")
    try {
      const restricted = await observeRuntimeDatabase(runtime)
      const global = await observeRuntimeDatabase(system, { runtime: false })
      check(
        global.databaseIdentity === restricted.databaseIdentity &&
          global.principal !== restricted.principal
      )
      const role = await system.query(
        "SELECT rolsuper OR rolbypassrls AS global_read FROM pg_catalog.pg_roles WHERE rolname=current_user"
      )
      check(role.rows.length === 1 && role.rows[0].global_read === true)
      const bytes = randomBytes(8),
        keys = [bytes.readInt32BE(0), bytes.readInt32BE(4)]
      const probe = "SELECT pg_try_advisory_xact_lock($1::integer,$2::integer) AS acquired"
      check((await runtime.query(probe, keys)).rows[0]?.acquired === true)
      check((await system.query(probe, keys)).rows[0]?.acquired === false)
    } finally {
      await runtime.query("ROLLBACK")
    }
  })
}
async function withRedis(fn) {
  const r = new Redis(process.env.REDIS_URL, {
    connectTimeout: 5000,
    commandTimeout: 5000,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    retryStrategy: () => null,
  })
  try {
    await r.connect()
    return await fn(r)
  } finally {
    r.disconnect(false)
  }
}
async function run(action, a) {
  if (action === "startup-policy") {
    const p = process.env,
      v = p.LYRASHIELD_EVIDENCE_WRITER_CANARY
    check(typeof p.DATABASE_URL === "string" && p.DATABASE_URL.length > 0)
    return {
      runRecordV11: p.LYRASHIELD_RUN_RECORD_V1_1,
      pendingHttpEvidence: p.LYRASHIELD_PENDING_HTTP_EVIDENCE,
      selectorHash: v ? hash("LYRASHIELD_EVIDENCE_WRITER_CANARY=" + v + "\n") : null,
      databaseUrlHash: hash(p.DATABASE_URL),
    }
  }
  if (action === "rpc") {
    const [op, one, two, three] = a
    return withRedis(async (r) => {
      if (op === "nx") return r.set(SCAN_ADMISSION_KEY, receipt(one), "NX")
      if (op === "state") return r.eval(holdStateLua, 1, SCAN_ADMISSION_KEY, receipt(one))
      if (op === "assert" || op === "release")
        return r.eval(OWNED_HOLD_LUA, 1, SCAN_ADMISSION_KEY, op, receipt(one))
      if (op === "rebind") {
        const old = JSON.parse(receipt(one)),
          next = JSON.parse(receipt(two))
        check(
          old.owner !== next.owner &&
            old.engineRevision === next.engineRevision &&
            old.workerDigest !== next.workerDigest
        )
      }
      if (op === "rebind" || op === "observe")
        return r.eval(
          op === "rebind" ? rebindLua : observeLua,
          1,
          SCAN_ADMISSION_KEY,
          receipt(one),
          receipt(two)
        )
      check(
        op === "armed-release" &&
          Number.isSafeInteger(two) &&
          Number.isSafeInteger(three) &&
          two > 0 &&
          three - two > 30000 &&
          three - two <= 900000
      )
      return r.eval(armedReleaseLua, 1, SCAN_ADMISSION_KEY, receipt(one), two, three)
    })
  }
  if (action === "drain") {
    try {
      await withRedis((r) =>
        connected(true, (db) =>
          assertPairedWorkDrained(
            r,
            db,
            async () => process.env.PAIRED_PHYSICAL_PROOF,
            bindGlobalSession
          )
        )
      )
    } catch (e) {
      if (e.constructor?.name === "PairedWorkPending") return "busy"
      throw e
    }
    return "drained"
  }
  if (action === "continuity") {
    const db = await connected(false, (c) => observeRuntimeDatabase(c))
    return {
      databaseIdentity: db.databaseIdentity,
      redisUrlHash: hash(process.env.REDIS_URL),
      databaseUrlHash: hash(process.env.DATABASE_URL),
    }
  }
  if (action === "relay") {
    const u = new URL(process.env.LYRASHIELD_TARGET_RELAY_URL)
    check(
      u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        !u.port &&
        u.hostname === a.relayHost &&
        u.pathname === "/" &&
        !u.search &&
        !u.hash
    )
    const token = process.env.LYRASHIELD_EGRESS_PROXY_SECRET
    check(token)
    const res = await fetch(new URL("/v1/register-owned/paired-readiness", u), {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
      redirect: "error",
      signal: AbortSignal.timeout(6000),
    })
    // Owned route validates proprietary owner header before parsing/installing any grant.
    check(res.status === 400)
    const b = await res.text()
    check(b.length < 256)
    const j = JSON.parse(b)
    check(j.ok === false && j.reason === "malformed")
    return true
  }
  return readOperation(action, a)
}
async function readOperation(action, a) {
  if (action === "unused") {
    const encoded = process.env.LYRASHIELD_EVIDENCE_WRITER_CANARY
    check(typeof encoded === "string" && /^[\w-]{1,2048}$/.test(encoded))
    check(hash("LYRASHIELD_EVIDENCE_WRITER_CANARY=" + encoded + "\n") === a.selectorHash)
    const s = JSON.parse(Buffer.from(encoded, "base64url"))
    id(s.workspaceId)
    id(s.principalId)
    id(s.requestId)
    return connected(true, async (db) => {
      await db.query("BEGIN READ ONLY")
      try {
        await bindGlobalSession(db)
        await db.query("SET LOCAL row_security=off")
        const { rows } = await db.query(
          `SELECT NOT EXISTS (SELECT 1 FROM public.agent_operations WHERE "workspaceId"=$1 AND "principalType"='BROWSER_SESSION' AND "principalId"=$2 AND "idempotencyKey"=$3 AND "operationName"='scan.create') AS unused`,
          [s.workspaceId, s.principalId, s.requestId]
        )
        return rows.length === 1 && rows[0].unused === true
      } finally {
        await db.query("ROLLBACK")
      }
    })
  }
  if (action === "accounted") {
    const { workspace, scan, operation } = a
    for (const v of [workspace, scan, operation]) id(v)
    return connected(true, async (db) => {
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
      try {
        await bindGlobalSession(db)
        await db.query("SET LOCAL row_security=off")
        const { rows } = await db.query(
          `SELECT s.id,s.status,s."accountingSettledAt" IS NOT NULL AS settled,r.state,r."stoppedAt" IS NOT NULL AS stopped,
     o.status AS operation,o."resultReference" AS result, o.result->>'id' AS "resultId" FROM public."Scan" s
     JOIN public."ScanCapacityReservation" r ON r."scanId"=s.id AND r."workspaceId"=s."workspaceId"
     JOIN public.agent_operations o ON o."workspaceId"=s."workspaceId" AND o.id=$3 AND o."principalId"=s."createdById"
     WHERE s.id=$2 AND s."workspaceId"=$1 AND o."operationName"='scan.create' AND o."principalType"='BROWSER_SESSION'`,
          [workspace, scan, operation]
        )
        const r = rows[0]
        return (
          rows.length === 1 &&
          ["COMPLETED", "FAILED", "PARTIAL", "CANCELLED", "TIMED_OUT", "STOPPED_BUDGET"].includes(
            r.status
          ) &&
          r.settled &&
          r.stopped &&
          ["RELEASED", "SETTLED"].includes(r.state) &&
          r.operation === "COMPLETED" &&
          r.result === scan &&
          r.resultId === scan
        )
      } finally {
        await db.query("ROLLBACK")
      }
    })
  }
  if (action === "evidence") {
    for (const k of ["workspace", "scan", "finding", "evidence"]) id(a[k])
    return connected(false, async (db) => {
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
      try {
        await db.query("SELECT set_config('app.current_workspace_id',$1,true)", [a.workspace])
        // Match loadEvidenceInsights: select the newest bound row (including
        // tombstones); a legacy fallback is allowed only for the origin scan
        // and only when there is no bound row or later candidate observation.
        check(["scan-observation", "legacy-origin"].includes(a.binding))
        const prefix = "ctx-" + hash(JSON.stringify([a.finding, a.scan])) + "-"
        const { rows } = await db.query(
          `SELECT e.id,e.type,e.checksum,e."storageUri",e."encryptionKeyRef",e."redactionStatus",f.id AS finding,f."scanId",f."workspaceId"
          FROM public."Evidence" e JOIN public."Finding" f ON f.id=e."findingId"
          WHERE f.id=$1 AND f."workspaceId"=$2 AND e.type='claim_context'
            AND (starts_with(e.id,$4) OR ($5='legacy-origin' AND NOT starts_with(e.id,'ctx-'))) AND
            (($5='scan-observation' AND (f."scanId"=$3 OR EXISTS
              (SELECT 1 FROM public."FindingCandidate" c JOIN public."Scan" s ON s.id=c."scanId"
               WHERE c."findingId"=f.id AND c."scanId"=$3 AND c."workspaceId"=$2 AND s."workspaceId"=$2 AND s."deletedAt" IS NULL))) OR
             ($5='legacy-origin' AND f."scanId"=$3 AND COALESCE(
              (SELECT c."scanId" FROM public."FindingCandidate" c JOIN public."Scan" s ON s.id=c."scanId"
               WHERE c."findingId"=f.id AND c."workspaceId"=$2 AND s."workspaceId"=$2 AND s."deletedAt" IS NULL
               ORDER BY c."createdAt" DESC,c.id DESC LIMIT 1),f."scanId")=$3))
          ORDER BY starts_with(e.id,$4) DESC,e."createdAt" DESC,e.id DESC LIMIT 1`,
          [a.finding, a.workspace, a.scan, prefix, a.binding]
        )
        check(
          rows.length === 1 &&
            rows[0].id === a.evidence &&
            rows[0].storageUri &&
            rows[0].redactionStatus !== "deleted"
        )
        const r = rows[0],
          storage = await import(base.resolve("@lyrashield/evidence-storage"))
        const opened = await storage.readEncryptedArtifact(r.storageUri, a.workspace)
        check(
          opened.legacy === false &&
            opened.checksum === r.checksum &&
            opened.encryptionKeyRef === r.encryptionKeyRef &&
            hash(opened.content) === r.checksum
        )
        const content = JSON.parse(opened.content.toString("utf8"))
        if (a.binding === "scan-observation") {
          check(
            r.id.startsWith("ctx-" + hash(JSON.stringify([a.finding, a.scan])) + "-") &&
              content.sourceScanId === a.scan &&
              content.sourceFindingId === a.finding
          )
        } else {
          check(
            a.binding === "legacy-origin" &&
              !r.id.startsWith("ctx-") &&
              r.scanId === a.scan &&
              content.sourceScanId === undefined &&
              content.sourceFindingId === undefined
          )
        }
        const ids = content.pendingHttpExchangeIds
        const pending =
          a.binding === "scan-observation" &&
          Array.isArray(ids) &&
          ids.length <= 10 &&
          ids.every((v) => typeof v === "string" && /^[0-9]{1,128}$/.test(v))
            ? [...new Set(ids)]
            : []
        const projection = hash(JSON.stringify(pending))
        check(projection === a.pendingProjection)
        return hash(
          JSON.stringify({
            workspace: r.workspaceId,
            scan: a.scan,
            finding: r.finding,
            evidence: r.id,
            checksum: r.checksum,
          })
        )
      } finally {
        await db.query("ROLLBACK")
      }
    })
  }
  throw new Error("Unrecognized operation")
}
try {
  const a = JSON.parse(Buffer.from(process.argv[3], "base64").toString())
  const result = await run(process.argv[2], a)
  process.stdout.write(JSON.stringify(result))
} catch {
  console.error("Protected worker observation unavailable")
  process.exitCode = 1
}
