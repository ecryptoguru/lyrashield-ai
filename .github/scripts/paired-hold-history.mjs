// Dormant two-key protocol. Callers must authenticate external anchors and the
// exclusive writer deployment before supplying any transition to this module.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  SCAN_ADMISSION_KEY,
  OWNED_HOLD_LUA,
  pairedReleaseReceipt,
} from "../../ops/monitoring/paired-release-hold.mjs"

export const HISTORY_KEY = "{lyrashield:scan-admission:stopped}:paired-history"
export const MAX_TRANSITIONS = 256
const hex = /^[a-f0-9]{64}$/
const digest = (s) => createHash("sha256").update(s).digest("hex")
const canonical = (o) => JSON.stringify(o)
const operations = new Set(["acquire", "rebind", "release", "armed-release"])
function hash(s) {
  assert.equal(typeof s, "string")
  assert.match(s, hex)
  return s
}
function receipt(raw) {
  if (raw === "") return raw
  assert.equal(typeof raw, "string")
  assert.ok(Buffer.byteLength(raw) <= 1024)
  const p = JSON.parse(raw)
  assert.equal(
    pairedReleaseReceipt(p.owner, p.productRevision, p.engineRevision, p.workerDigest),
    raw
  )
  return raw
}
function fields(o, keys) {
  assert.deepEqual(Object.keys(o).sort(), [...keys].sort())
}
export function validateAnchor(a) {
  fields(a, ["v", "epoch", "authority", "seq", "head", "receipt"])
  assert.equal(a.v, 1)
  hash(a.epoch)
  hash(a.authority)
  hash(a.head)
  receipt(a.receipt)
  assert.ok(Number.isSafeInteger(a.seq) && a.seq > 0 && a.seq <= MAX_TRANSITIONS)
  return a
}
export function prepareTransition(
  prior,
  { operation, epoch, authority, intent, nextReceipt, issuedAtMs, expiresAtMs }
) {
  assert.ok(operations.has(operation))
  hash(epoch)
  hash(authority)
  hash(intent)
  receipt(nextReceipt)
  if (prior !== null) validateAnchor(prior)
  const seq = (prior?.seq ?? 0) + 1
  assert.ok(seq <= MAX_TRANSITIONS, "paired history exhausted")
  if (operation === "acquire") {
    assert.equal(prior?.receipt ?? "", "")
    assert.notEqual(epoch, prior?.epoch)
    assert.notEqual(nextReceipt, "")
  } else {
    assert.ok(prior && prior.receipt !== "")
    assert.equal(epoch, prior.epoch)
    assert.equal(authority, prior.authority)
    if (operation === "rebind") {
      assert.notEqual(nextReceipt, "")
      assert.notEqual(nextReceipt, prior.receipt)
      assert.notEqual(JSON.parse(nextReceipt).owner, JSON.parse(prior.receipt).owner)
    } else assert.equal(nextReceipt, "")
  }
  if (operation === "armed-release") {
    assert.ok(Number.isSafeInteger(issuedAtMs) && Number.isSafeInteger(expiresAtMs))
    assert.ok(
      issuedAtMs > 0 && expiresAtMs - issuedAtMs >= 30000 && expiresAtMs - issuedAtMs <= 900000
    )
  } else {
    assert.equal(issuedAtMs, undefined)
    assert.equal(expiresAtMs, undefined)
  }
  const entry = {
    v: 1,
    seq,
    operation,
    epoch,
    authority,
    intent,
    previous: prior?.head ?? "0".repeat(64),
    before: prior?.receipt ?? "",
    after: nextReceipt,
    issuedAtMs: issuedAtMs ?? 0,
    expiresAtMs: expiresAtMs ?? 0,
  }
  const raw = canonical(entry)
  return Object.freeze({
    prior: prior === null ? null : canonical(prior),
    entry: raw,
    anchor: canonical({ v: 1, epoch, authority, seq, head: digest(raw), receipt: nextReceipt }),
  })
}

// Both writes follow validation. If the second write errors, the advanced
// intent is retained; neither old nor destination anchor then verifies.
export const TRANSITION_LUA = `
if #KEYS ~= 2 or KEYS[1] ~= "lyrashield:scan-admission:stopped" or KEYS[2] ~= "{lyrashield:scan-admission:stopped}:paired-history" then return redis.error_reply("invalid paired keys") end
local kt=redis.call("TYPE",KEYS[1]).ok
local ht=redis.call("TYPE",KEYS[2]).ok
if (kt~="none" and kt~="string") or (ht~="none" and ht~="hash") then return redis.error_reply("invalid paired types") end
local e=cjson.decode(ARGV[2]); local a=cjson.decode(ARGV[3])
if a.seq~=e.seq or a.epoch~=e.epoch or a.authority~=e.authority or a.receipt~=e.after or e.seq<1 or e.seq>256 then return redis.error_reply("invalid paired intent") end
local current=redis.call("GET",KEYS[1]) or ""
if current~=e.before or (current~="" and redis.call("PTTL",KEYS[1])~=-1) then return redis.error_reply("paired hold changed") end
if ARGV[1]=="" then
 if ht~="none" or e.seq~=1 or e.operation~="acquire" or e.before~="" then return redis.error_reply("unproven paired origin") end
else
 if ht~="hash" or redis.call("PTTL",KEYS[2])~=-1 or redis.call("HGET",KEYS[2],"anchor")~=ARGV[1] then return redis.error_reply("paired history changed") end
 local p=cjson.decode(ARGV[1]); if p.seq+1~=e.seq or p.head~=e.previous or p.receipt~=e.before then return redis.error_reply("paired predecessor changed") end
end
local entries=cjson.decode(ARGV[4])
if #entries~=e.seq-1 or (ht=="hash" and redis.call("HLEN",KEYS[2])~=e.seq) then return redis.error_reply("paired history truncated") end
for i=1,#entries do if redis.call("HGET",KEYS[2],"entry:"..i)~=entries[i] then return redis.error_reply("paired history bytes changed") end end
if redis.call("HEXISTS",KEYS[2],"entry:"..e.seq)==1 then return redis.error_reply("paired intent consumed") end
if e.operation=="armed-release" then
 local t=redis.call("TIME"); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
 if now<e.issuedAtMs or now+30000>=e.expiresAtMs then return redis.error_reply("paired lease expired") end
end
redis.call("HSET",KEYS[2],"anchor",ARGV[3],"entry:"..e.seq,ARGV[2])
if e.after=="" then redis.call("DEL",KEYS[1]) else redis.call("SET",KEYS[1],e.after) end
return ARGV[3]`

export const OBSERVE_LUA = `
local kt=redis.call("TYPE",KEYS[1]).ok;local ht=redis.call("TYPE",KEYS[2]).ok
if (kt~="none" and kt~="string") or (ht~="none" and ht~="hash") then return {"invalid"} end
if kt=="string" and redis.call("STRLEN",KEYS[1])>1024 then return {"invalid"} end
local anchor="";local entries={}
if ht=="hash" then
 if redis.call("HSTRLEN",KEYS[2],"anchor")>2048 then return {"invalid"} end
 anchor=redis.call("HGET",KEYS[2],"anchor") or ""
 local ok,a=pcall(cjson.decode,anchor)
 if not ok or type(a.seq)~="number" or a.seq<1 or a.seq>256 or a.seq~=math.floor(a.seq) or redis.call("HLEN",KEYS[2])~=a.seq+1 then return {"invalid"} end
 for i=1,a.seq do
  local name="entry:"..i
  if redis.call("HSTRLEN",KEYS[2],name)>4096 then return {"invalid"} end
  entries[i]=redis.call("HGET",KEYS[2],name) or ""
 end
end
return {redis.call("GET",KEYS[1]) or "",redis.call("PTTL",KEYS[1]),anchor,redis.call("PTTL",KEYS[2]),entries}`
async function snapshot(redis) {
  const r = await redis.eval(OBSERVE_LUA, 2, SCAN_ADMISSION_KEY, HISTORY_KEY)
  assert.ok(Array.isArray(r) && r.length === 5 && Array.isArray(r[4]))
  let prior = null
  const seen = new Set()
  for (const raw of r[4]) {
    assert.equal(typeof raw, "string")
    assert.ok(Buffer.byteLength(raw) <= 4096)
    const e = JSON.parse(raw)
    assert.ok(!seen.has(e.intent), "paired intent replay")
    seen.add(e.intent)
    const rebuilt = prepareTransition(prior, {
      operation: e.operation,
      epoch: e.epoch,
      authority: e.authority,
      intent: e.intent,
      nextReceipt: e.after,
      ...(e.operation === "armed-release"
        ? { issuedAtMs: e.issuedAtMs, expiresAtMs: e.expiresAtMs }
        : {}),
    })
    assert.equal(rebuilt.entry, raw)
    prior = JSON.parse(rebuilt.anchor)
  }
  assert.equal(r[2], prior === null ? "" : canonical(prior))
  return r
}

export async function verifyJournalAnchor(redis, expected) {
  validateAnchor(expected)
  const expectedRaw = canonical(expected)
  expected = Object.freeze(JSON.parse(expectedRaw))
  const raw = await snapshot(redis)
  const result = raw.slice(0, 4)
  assert.deepEqual(
    result,
    [expected.receipt, expected.receipt === "" ? -2 : -1, expectedRaw, -1],
    "paired continuity unproven"
  )
  return Object.freeze(JSON.parse(expectedRaw))
}
export async function inspectTransition(redis, command) {
  command = qualifiedCommand(command).command
  const next = JSON.parse(command.anchor)
  validateAnchor(next)
  const old = command.prior === null ? null : JSON.parse(command.prior)
  const r = (await snapshot(redis)).slice(0, 4)
  if (canonical(r) === canonical([next.receipt, next.receipt === "" ? -2 : -1, command.anchor, -1]))
    return "destination"
  if (
    old &&
    canonical(r) === canonical([old.receipt, old.receipt === "" ? -2 : -1, command.prior, -1])
  )
    return "source"
  // An absent first origin cannot distinguish unattempted from applied then lost.
  // Only the protected external single-use intent may authorize its first send.
  return "unknown"
}
function qualifiedCommand(input) {
  const command = Object.freeze({ ...input })
  const e = JSON.parse(command.entry),
    prior = command.prior === null ? null : JSON.parse(command.prior)
  const rebuilt = prepareTransition(prior, {
    operation: e.operation,
    epoch: e.epoch,
    authority: e.authority,
    intent: e.intent,
    nextReceipt: e.after,
    ...(e.operation === "armed-release"
      ? { issuedAtMs: e.issuedAtMs, expiresAtMs: e.expiresAtMs }
      : {}),
  })
  assert.deepEqual(command, rebuilt)
  return { command, e, prior }
}

export async function applyTransition(redis, command) {
  const qualified = qualifiedCommand(command)
  command = qualified.command
  const { e, prior } = qualified
  const observed = await snapshot(redis)
  assert.ok(!observed[4].some((raw) => JSON.parse(raw).intent === e.intent), "paired intent replay")
  assert.deepEqual(
    observed.slice(0, 4),
    prior === null
      ? ["", -2, "", -2]
      : [prior.receipt, prior.receipt === "" ? -2 : -1, command.prior, -1]
  )
  const result = await redis.eval(
    TRANSITION_LUA,
    2,
    SCAN_ADMISSION_KEY,
    HISTORY_KEY,
    command.prior ?? "",
    command.entry,
    command.anchor,
    JSON.stringify(observed[4])
  )
  assert.equal(result, command.anchor)
  return verifyJournalAnchor(redis, JSON.parse(command.anchor))
}

// Optional closed gateway for historical owned operations. The old receipt
// builder/module is untouched; deployment must prevent direct writer access to
// the unwrapped legacy entrypoint before this can qualify an exclusive window.
const LEGACY_LUA =
  `
local t=redis.call("TYPE",KEYS[2]).ok
if t~="none" and t~="hash" then return redis.error_reply("unproven legacy window") end
local actual=t=="hash" and (redis.call("HGET",KEYS[2],"anchor") or "") or ""
if actual~=ARGV[3] or (t=="hash" and redis.call("PTTL",KEYS[2])~=-1) then return redis.error_reply("legacy window changed") end
local entries=cjson.decode(ARGV[4])
if t=="hash" and redis.call("HLEN",KEYS[2])~=#entries+1 then return redis.error_reply("legacy history changed") end
for i=1,#entries do if redis.call("HGET",KEYS[2],"entry:"..i)~=entries[i] then return redis.error_reply("legacy history bytes changed") end end
` + OWNED_HOLD_LUA
export async function legacyOwnedHold(redis, operation, ...identity) {
  assert.ok(["claim", "assert", "release"].includes(operation))
  const rawReceipt = pairedReleaseReceipt(...identity)
  const observed = await snapshot(redis)
  if (observed[2] !== "")
    assert.equal(
      JSON.parse(observed[2]).receipt,
      "",
      "active paired window rejects legacy operations"
    )
  const result = await redis.eval(
    LEGACY_LUA,
    2,
    SCAN_ADMISSION_KEY,
    HISTORY_KEY,
    operation,
    rawReceipt,
    observed[2],
    JSON.stringify(observed[4])
  )
  assert.equal(Number(result), 1, "legacy owned operation refused")
  return rawReceipt
}
