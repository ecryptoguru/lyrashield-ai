// Isolated tools execute inside the pinned worker image, using the existing
// worker authority and no Docker socket. Only finite RPC operations are admitted.
import { createRequire } from "node:module"
import { createHash } from "node:crypto"
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
          assertPairedWorkDrained(r, db, async () => process.env.PAIRED_PHYSICAL_PROOF)
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
        const { rows } = await db.query(
          `SELECT e.id,e.checksum,e."storageUri",e."encryptionKeyRef",f.id AS finding,f."scanId",f."workspaceId"
     FROM public."Evidence" e JOIN public."Finding" f ON f.id=e."findingId"
     WHERE e.id=$1 AND e.type='claim_context' AND e."redactionStatus"<>'deleted' AND f.id=$2 AND f."workspaceId"=$4 AND
     (f."scanId"=$3 OR EXISTS(SELECT 1 FROM public."FindingCandidate" c WHERE c."findingId"=f.id AND c."scanId"=$3 AND c."workspaceId"=$4))`,
          [a.evidence, a.finding, a.scan, a.workspace]
        )
        check(rows.length === 1)
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
              r.scanId === a.scan &&
              content.sourceScanId === undefined &&
              content.sourceFindingId === undefined
          )
        }
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
