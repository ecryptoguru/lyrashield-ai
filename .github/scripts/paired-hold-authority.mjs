// Read-only deployment qualification. These are proposals, never provisioning.
import assert from "node:assert/strict"
import { SCAN_ADMISSION_KEY } from "../../ops/monitoring/paired-release-hold.mjs"
import { HISTORY_KEY } from "./paired-hold-history.mjs"

// Inventory is deliberately explicit. Unknown future Redis writers require a
// reviewed addition; there is no broad lyrashield:* write permission.
export const RUNTIME_WRITE_PATTERNS = Object.freeze([
  "bull:*",
  "lyrashield:scan-workers",
  "lyrashield:scan-queue:reconciliation",
  "lyrashield:ai-cache:v1:triage:*",
  "github:token:v2:*",
  "turnstile-proof:v1:*",
  "@upstash/ratelimit:*",
  "billing-checkout-lock:*",
])
export function runtimeAclRules() {
  return [
    "reset",
    "on",
    "resetkeys",
    "%R~*",
    ...RUNTIME_WRITE_PATTERNS.map((p) => "%W~" + p),
    "resetchannels",
    "&*",
    "+@all",
    "-@admin",
    "-@dangerous",
    "-keys",
    "-script|flush",
    "-script|kill",
    "-function",
  ]
}
export function writerAclRules() {
  return [
    "reset",
    "on",
    "resetkeys",
    "~" + SCAN_ADMISSION_KEY,
    "~" + HISTORY_KEY,
    "resetchannels",
    "-@all",
    "+ping",
    "+get",
    "+set",
    "+del",
    "+type",
    "+pttl",
    "+hget",
    "+hset",
    "+hexists",
    "+hlen",
    "+hstrlen",
    "+strlen",
    "+eval",
    "+time",
  ]
}
function fields(reply) {
  if (reply && !Array.isArray(reply) && typeof reply === "object")
    reply = Object.entries(reply).flat()
  assert.ok(Array.isArray(reply) && reply.length % 2 === 0)
  const m = new Map()
  for (let i = 0; i < reply.length; i += 2) {
    assert.equal(typeof reply[i], "string")
    assert.ok(!m.has(reply[i]))
    m.set(reply[i], reply[i + 1])
  }
  return m
}
function rules(raw) {
  assert.equal(typeof raw, "string")
  return raw.split(/\s+/).filter(Boolean).sort()
}
async function dry(admin, user, args, allowed) {
  let result
  try {
    result = await admin.call("ACL", "DRYRUN", user, ...args)
  } catch (e) {
    if (!allowed && /NOPERM|no permissions/i.test(String(e?.message))) return
    throw new Error("paired permission probe unavailable")
  }
  if (!allowed && typeof result === "string" && /NOPERM|no permissions/i.test(result)) return
  assert.ok(allowed && result === "OK", "unexpected paired Redis permission")
}
export async function verifyPairedRolePolicy(admin, { runtimeUser, writerUser }) {
  assert.match(runtimeUser, /^[a-z][a-z0-9-]{0,63}$/)
  assert.match(writerUser, /^[a-z][a-z0-9-]{0,63}$/)
  assert.notEqual(runtimeUser, writerUser)
  assert.notEqual(runtimeUser, "default")
  assert.notEqual(writerUser, "default")
  const runtime = fields(await admin.call("ACL", "GETUSER", runtimeUser))
  const writer = fields(await admin.call("ACL", "GETUSER", writerUser))
  for (const user of [runtime, writer]) {
    assert.ok(user.get("flags")?.includes("on"))
    assert.deepEqual(user.get("selectors"), [])
    assert.ok(
      !user.get("flags").includes("nopass"),
      "paired roles require authenticated credentials"
    )
    const passwordHashes = user.get("passwords")
    assert.ok(
      Array.isArray(passwordHashes) &&
        passwordHashes.length > 0 &&
        passwordHashes.every((p) => typeof p === "string" && /^[a-f0-9]{64}$/.test(p)),
      "paired role credentials unavailable"
    )
  }
  // Exact key-rule grammar; selectors and broad writes cannot be hidden behind
  // sampled DRYRUN checks. Password fields are never returned or logged.
  assert.deepEqual(
    rules(runtime.get("keys")),
    rules(["%R~*", ...RUNTIME_WRITE_PATTERNS.map((p) => "%W~" + p)].join(" "))
  )
  assert.deepEqual(rules(writer.get("keys")), rules("~" + SCAN_ADMISSION_KEY + " ~" + HISTORY_KEY))
  assert.deepEqual(
    rules(runtime.get("commands")),
    runtimeAclRules()
      .filter((r) => r.startsWith("+") || r.startsWith("-"))
      .sort(),
    "unreviewed runtime commands"
  )
  assert.deepEqual(
    rules(writer.get("commands")),
    writerAclRules()
      .filter((r) => r.startsWith("+") || r.startsWith("-"))
      .sort(),
    "unreviewed protected writer commands"
  )
  for (const key of [SCAN_ADMISSION_KEY, HISTORY_KEY]) {
    await dry(admin, runtimeUser, ["GET", key], true)
    for (const args of [
      ["SET", key, "probe"],
      ["DEL", key],
      ["EXPIRE", key, "1"],
    ])
      await dry(admin, runtimeUser, args, false)
    for (const args of [
      ["GET", key],
      ["SET", key, "probe"],
      ["DEL", key],
    ])
      await dry(admin, writerUser, args, true)
  }
  for (const key of ["bull:scans:wait", "outside-authority"]) {
    await dry(admin, writerUser, ["SET", key, "probe"], false)
  }
  for (const args of [
    ["FLUSHALL"],
    ["CONFIG", "SET", "notify-keyspace-events", "A"],
    ["ACL", "SETUSER", "probe", "on"],
    ["SCRIPT", "FLUSH"],
  ]) {
    await dry(admin, runtimeUser, args, false)
    await dry(admin, writerUser, args, false)
  }
  const users = await admin.call("ACL", "USERS")
  assert.ok(Array.isArray(users) && users.length > 0 && users.length <= 64)
  assert.equal(new Set(users).size, users.length)
  for (const name of users) {
    assert.equal(typeof name, "string")
    assert.ok(name.length <= 128)
    if (name === writerUser) continue
    const info = fields(await admin.call("ACL", "GETUSER", name))
    const otherHashes = info.get("passwords")
    assert.ok(Array.isArray(otherHashes), "unavailable Redis credential inventory")
    assert.ok(
      !otherHashes.some((p) => writer.get("passwords").includes(p)),
      "protected writer credential is shared"
    )
    // OFF prevents new AUTH but does not revoke already authenticated clients.
    // Only an empty command/key grant is a fully revoked historical user.
    if (
      info.get("flags")?.includes("off") &&
      rules(info.get("commands")).join(" ") === "-@all" &&
      info.get("keys") === ""
    )
      continue
    if (name !== runtimeUser) {
      assert.equal(info.get("keys"), "", "unreviewed Redis principal")
      const permitted = new Set(["-@all", "+ping", "+acl|users", "+acl|getuser", "+acl|dryrun"])
      const commands = rules(info.get("commands"))
      assert.ok(
        commands.includes("-@all") && commands.every((c) => permitted.has(c)),
        "unreviewed Redis principal commands"
      )
    }

    for (const key of [SCAN_ADMISSION_KEY, HISTORY_KEY]) {
      for (const args of [
        ["SET", key, "probe"],
        ["DEL", key],
        ["EXPIRE", key, "1"],
      ])
        await dry(admin, name, args, false)
    }
    for (const args of [
      ["ACL", "SETUSER", "probe", "on"],
      ["CONFIG", "SET", "notify-keyspace-events", "A"],
      ["FLUSHALL"],
    ])
      await dry(admin, name, args, false)
  }
  return Object.freeze({
    runtimeUser,
    writerUser,
    checkedUsers: users.length,
    admissionReadOnly: true,
    writerKeys: [SCAN_ADMISSION_KEY, HISTORY_KEY],
  })
}
