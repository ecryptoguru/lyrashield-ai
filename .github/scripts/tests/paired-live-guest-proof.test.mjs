import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

const hash = (v) => createHash("sha256").update(v).digest("hex")
const root = new URL("../", import.meta.url)
function guest(t) {
  const dir = mkdtempSync(join(tmpdir(), "paired-guest-proof-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private fixture path
  const original = readFileSync(new URL("paired-live-guest.mjs", root), "utf8")
  const deps = `
 import {createHash,randomBytes} from "node:crypto"
 import {spawnSync} from "node:child_process"
 import {observeRuntimeDatabase} from ${JSON.stringify(new URL("v26-runtime-database.mjs", root).href)}
 import {assertPairedWorkDrained} from ${JSON.stringify(new URL("paired-runtime-hold.mjs", root).href)}
 const f=JSON.parse(process.env.FIXTURE)
 const base={resolve:()=> "data:text/javascript,export async function readEncryptedArtifact(uri){return globalThis.opened(uri)}"}
 globalThis.opened=uri=>{const c=Buffer.from(JSON.stringify(f.bodies[uri]));return {legacy:false,encryptionKeyRef:"k",content:c,checksum:createHash("sha256").update(c).digest("hex")}}
 class Redis{async connect(){}disconnect(){} async llen(){return 0}async zcard(){return 0}}
 class Client{constructor(options){this.system=options.connectionString==="system";this.url=options.connectionString}
 async connect(){}async end(){}
 async query(q,args){
 if(q.includes("current_database()"))return {rows:[{principal:this.system?"ops":"app",database:this.system?f.systemDb:f.runtimeDb,database_oid:"42",server:"10.0.1.8",schema:"public",rolsuper:false,rolbypassrls:this.system}]}
 if(q.includes("pg_try_advisory_xact_lock")){if(!this.system){globalThis.lock=args;return {rows:[{acquired:true}]}}return {rows:[{acquired:f.separateLockManager===true||JSON.stringify(globalThis.lock)!==JSON.stringify(args)}]}}
 if(q.includes(" AS global_read"))return {rows:[{global_read:f.globalRole!==false}]}
 if(q.includes(' AS drained'))return {rows:[{drained:!f.busy}]}
 if(q.includes(' AS unused'))return {rows:[{unused:!f.used}]}
 if(q.includes(' AS "resultId"'))return {rows:[{id:"scan",status:"COMPLETED",settled:true,state:"SETTLED",stopped:true,operation:"COMPLETED",result:"scan",resultId:"scan"}]}
 if(q.includes('FROM public."Evidence"')){
 const r=spawnSync("python3",["-I",process.env.SQL_FIXTURE],{input:JSON.stringify({q,args,f}),encoding:"utf8"});if(r.status!==0)throw Error("SQL fixture failed")
 return {rows:JSON.parse(r.stdout)}}
 if(!/^(BEGIN|ROLLBACK|SET LOCAL|SELECT set_config)/.test(q))throw Error("unexpected query");return {rows:[]}
 }}
 `
  // Keep the deployed guest decisions and SQL unchanged; only the transport is local.
  const guestFile = join(dir, "guest.mjs"),
    sql = join(dir, "query.py")
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private test scratch
  writeFileSync(guestFile, deps + original.slice(original.indexOf("const hash =")))
  // Execute the exact selection SQL with actual sort/filter/limit semantics.
  // SQLite supports the same named parameters and a deterministic starts_with implementation.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private test scratch
  writeFileSync(
    sql,
    `import json,sys,sqlite3
x=json.load(sys.stdin); db=sqlite3.connect(":memory:");db.row_factory=sqlite3.Row
db.create_function("starts_with",2,lambda value,prefix:value.startswith(prefix))
db.executescript("""ATTACH ':memory:' AS public; CREATE TABLE public.Finding(id,workspaceId,scanId);
CREATE TABLE public.Evidence(id,findingId,type,createdAt,checksum,storageUri,encryptionKeyRef,redactionStatus);
CREATE TABLE public.FindingCandidate(id,findingId,scanId,workspaceId,createdAt);
CREATE TABLE public.Scan(id,workspaceId,deletedAt);""")
db.execute("INSERT INTO public.Finding VALUES ('finding','ws','scan')")
for row in x['f']['rows']:db.execute("INSERT INTO public.Evidence VALUES (?,?,?,?,?,?,?,?)",row)
for scan in x['f'].get('otherScans',[]):
 db.execute("INSERT INTO public.Scan VALUES (?,'ws',NULL)",[scan]);db.execute("INSERT INTO public.FindingCandidate VALUES ('later','finding',?,'ws',9)",[scan])
print(json.dumps([dict(r) for r in db.execute(x['q'],{str(i+1):v for i,v in enumerate(x['args'])})]))
`
  )
  return (action, args = {}, fields = {}) => {
    const encoded = Buffer.from(
      JSON.stringify({ workspaceId: "ws", principalId: "user", requestId: "req" })
    ).toString("base64url")
    const input =
      action === "unused"
        ? { selectorHash: hash("LYRASHIELD_EVIDENCE_WRITER_CANARY=" + encoded + "\n") }
        : args
    return spawnSync(
      process.execPath,
      [guestFile, action, Buffer.from(JSON.stringify(input)).toString("base64")],
      {
        encoding: "utf8",
        timeout: 5000,
        env: {
          ...process.env,
          FIXTURE: JSON.stringify({ systemDb: "app", runtimeDb: "app", ...fields }),
          SQL_FIXTURE: sql,
          DATABASE_URL: "runtime",
          DATABASE_SYSTEM_URL: "system",
          PAIRED_RUNTIME_DB_HASH: fields.expectedHash ?? hash("runtime"),
          PAIRED_PHYSICAL_PROOF: "V26_EXECUTION_DRAIN_VERIFIED",
          LYRASHIELD_EVIDENCE_WRITER_CANARY: encoded,
        },
      }
    )
  }
}
for (const action of ["drain", "unused", "accounted"])
  test("actual " + action + " requires a global role on the restricted runtime database", (t) => {
    const run = guest(t),
      args = { workspace: "ws", scan: "scan", operation: "operation" }
    const pass = run(action, args)
    assert.equal(pass.status, 0, pass.stderr)
    assert.equal(JSON.parse(pass.stdout), action === "drain" ? "drained" : true)
    for (const mismatch of [
      { systemDb: "empty-shadow" },
      { expectedHash: hash("stale service") },
      { globalRole: false },
      { separateLockManager: true },
    ]) {
      const bad = run(action, args, mismatch)
      assert.notEqual(bad.status, 0)
      assert.equal(bad.stdout, "")
    }
    if (action === "drain")
      assert.equal(JSON.parse(run(action, args, { busy: true }).stdout), "busy")
  })
test("decryption selects exactly the dashboard context and binds its actual pending IDs", (t) => {
  const run = guest(t),
    prefix = "ctx-" + hash(JSON.stringify(["finding", "scan"])) + "-",
    first = prefix + "a",
    last = prefix + "z"
  const bodies = {
    first: { sourceScanId: "scan", sourceFindingId: "finding" },
    last: {
      sourceScanId: "scan",
      sourceFindingId: "finding",
      pendingHttpExchangeIds: ["123", "123"],
    },
    legacy: {},
  }
  const row = (id, uri, when, status = "clean") => [
    id,
    "finding",
    "claim_context",
    when,
    hash(JSON.stringify(bodies[uri])),
    uri,
    "k",
    status,
  ]
  const probe = (id, rows, ids, binding = "scan-observation", extra = {}) =>
    run(
      "evidence",
      {
        workspace: "ws",
        scan: "scan",
        finding: "finding",
        evidence: id,
        binding,
        pendingProjection: hash(JSON.stringify(ids)),
      },
      { rows, bodies, ...extra }
    )
  const rows = [row(first, "first", 1), row(last, "last", 1), row("legacy", "legacy", 3)]
  assert.notEqual(probe(first, rows, ["123"]).status, 0)
  assert.equal(probe(last, rows, ["123"]).status, 0)
  assert.notEqual(probe(last, rows, ["456"]).status, 0)
  assert.notEqual(
    probe(first, [row(first, "first", 1), row(last, "last", 2, "deleted")], []).status,
    0
  )
  assert.notEqual(probe("legacy", rows, [], "legacy-origin").status, 0)
  assert.equal(probe("legacy", [rows[2]], [], "legacy-origin").status, 0)
  assert.notEqual(
    probe("legacy", [rows[2]], [], "legacy-origin", { otherScans: ["later"] }).status,
    0
  )
})
