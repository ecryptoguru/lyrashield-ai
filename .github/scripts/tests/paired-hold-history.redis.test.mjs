import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import {
  legacyOwnedHold,
  prepareTransition,
  applyTransition,
  inspectTransition,
  verifyJournalAnchor,
  HISTORY_KEY,
} from "../paired-hold-history.mjs"
import {
  runtimeAclRules,
  writerAclRules,
  verifyPairedRolePolicy,
} from "../paired-hold-authority.mjs"
import {
  pairedReleaseReceipt,
  SCAN_ADMISSION_KEY,
} from "../../../ops/monitoring/paired-release-hold.mjs"
const cid = process.env.PAIRED_HISTORY_REDIS_CONTAINER
const H = (c) => c.repeat(64)
const receipt = (owner) =>
  pairedReleaseReceipt(owner, "a".repeat(40), "b".repeat(40), "sha256:" + "c".repeat(64))
const cli = (...args) => {
  const raw = execFileSync(
    "docker",
    ["exec", cid, "redis-cli", "--no-auth-warning", "--json", ...args.map(String)],
    { encoding: "utf8", timeout: 10000, maxBuffer: 131072 }
  )
  if (raw.startsWith("error:")) throw new Error(raw)
  if (args[0] === "CLUSTER" && args[1] === "INFO") return raw
  const result = JSON.parse(raw)
  if (result?.error) throw new Error(result.error)
  return result
}
const redis = {
  eval: async (...args) => cli("EVAL", ...args),
  call: async (...args) => cli(...args),
}
const initial = () =>
  prepareTransition(null, {
    operation: "acquire",
    epoch: H("d"),
    authority: H("e"),
    intent: H("f"),
    nextReceipt: receipt("10:1"),
  })
const next = (prior, operation, rest = {}) =>
  prepareTransition(prior, {
    operation,
    epoch: prior.epoch,
    authority: prior.authority,
    intent: H("1"),
    nextReceipt: operation === "rebind" ? receipt("11:1") : "",
    ...rest,
  })
test(
  "bounded actual Redis cluster history and role policy",
  { skip: !cid, timeout: 60000 },
  async (t) => {
    assert.match(cid, /^[a-f0-9]{64}$/)
    const [meta] = JSON.parse(execFileSync("docker", ["inspect", cid], { encoding: "utf8" }))
    assert.equal(meta.Config.Labels["com.lyrashield.drill"], "paired-history")
    assert.equal(meta.HostConfig.NetworkMode, "none")
    for (let i = 0; i < 50 && !cli("CLUSTER", "INFO").includes("cluster_state:ok"); i++)
      await delay(100)
    assert.ok(cli("CLUSTER", "INFO").includes("cluster_state:ok"))
    assert.equal(cli("DBSIZE"), 0)
    assert.equal(
      cli("CLUSTER", "KEYSLOT", SCAN_ADMISSION_KEY),
      cli("CLUSTER", "KEYSLOT", HISTORY_KEY)
    )
    cli("CONFIG", "SET", "maxmemory", 1)
    await assert.rejects(applyTransition(redis, initial()))
    cli("CONFIG", "SET", "maxmemory", 0)
    assert.equal(cli("DBSIZE"), 0)
    const legacyIdentity = ["99:1", "a".repeat(40), "b".repeat(40), "sha256:" + H("c")]
    await legacyOwnedHold(redis, "claim", ...legacyIdentity)
    await legacyOwnedHold(redis, "assert", ...legacyIdentity)
    await legacyOwnedHold(redis, "release", ...legacyIdentity)
    const command = initial()
    assert.equal(await inspectTransition(redis, command), "unknown")
    const a = await applyTransition(redis, command)
    await assert.rejects(
      legacyOwnedHold(redis, "release", "10:1", "a".repeat(40), "b".repeat(40), "sha256:" + H("c"))
    )
    assert.equal(cli("GET", SCAN_ADMISSION_KEY), a.receipt)
    assert.equal(cli("PTTL", HISTORY_KEY), -1)
    assert.equal(cli("PTTL", SCAN_ADMISSION_KEY), -1)
    await assert.rejects(applyTransition(redis, command))
    assert.equal(await inspectTransition(redis, command), "destination")
    // Real competing commands serialize: one rebind, one release.
    const results = await Promise.allSettled([
      applyTransition(redis, next(a, "rebind")),
      applyTransition(redis, next(a, "release")),
    ])
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 1)
    const anchor = results.find((x) => x.status === "fulfilled").value
    await assert.rejects(verifyJournalAnchor(redis, a))
    await verifyJournalAnchor(redis, anchor)
    // Stale external anchor cannot bless deleted or restored/truncated history.
    cli("DEL", HISTORY_KEY)
    await assert.rejects(verifyJournalAnchor(redis, anchor))
    await assert.rejects(applyTransition(redis, next(anchor, "release")))
    cli("FLUSHDB")
    cli("SET", HISTORY_KEY, "wrong-type")
    await assert.rejects(applyTransition(redis, initial()))
    assert.equal(cli("EXISTS", SCAN_ADMISSION_KEY), 0)
    cli("FLUSHDB")
    const owner = await applyTransition(redis, initial())
    await assert.rejects(applyTransition(redis, next(owner, "rebind", { intent: H("f") })))
    cli("HSET", HISTORY_KEY, "entry:1", "corrupt")
    await assert.rejects(verifyJournalAnchor(redis, owner))
    await assert.rejects(applyTransition(redis, next(owner, "rebind")))
    assert.equal(cli("GET", SCAN_ADMISSION_KEY), owner.receipt)
    cli("HSET", HISTORY_KEY, "entry:1", initial().entry)
    const now = Date.now()
    await assert.rejects(
      applyTransition(
        redis,
        next(owner, "armed-release", { issuedAtMs: now - 60000, expiresAtMs: now - 1000 })
      )
    )
    await verifyJournalAnchor(redis, owner)
    const armed = next(owner, "armed-release", {
      issuedAtMs: now - 1000,
      expiresAtMs: now + 120000,
    })
    // Simulate an applied command's lost ACK by deliberately discarding result.
    await redis.eval(
      (await import("../paired-hold-history.mjs")).TRANSITION_LUA,
      2,
      SCAN_ADMISSION_KEY,
      HISTORY_KEY,
      armed.prior,
      armed.entry,
      armed.anchor,
      JSON.stringify([initial().entry])
    )
    assert.equal(await inspectTransition(redis, armed), "destination")
    await assert.rejects(applyTransition(redis, armed))
    await legacyOwnedHold(redis, "claim", ...legacyIdentity)
    await legacyOwnedHold(redis, "release", ...legacyIdentity)
    const closed = JSON.parse(armed.anchor)
    const reopen = prepareTransition(closed, {
      operation: "acquire",
      epoch: H("2"),
      authority: H("e"),
      intent: H("3"),
      nextReceipt: receipt("12:1"),
    })
    await applyTransition(redis, reopen)
    await assert.rejects(verifyJournalAnchor(redis, owner))
    // A real second-write permission failure must retain unknown journal state.
    const secret = randomUUID()
    cli(
      "ACL",
      "SETUSER",
      "partial",
      "reset",
      "on",
      ">" + secret,
      "~" + SCAN_ADMISSION_KEY,
      "~" + HISTORY_KEY,
      "-@all",
      "+eval",
      "+get",
      "+type",
      "+pttl",
      "+hget",
      "+hstrlen",
      "+strlen",
      "+hlen",
      "+hset",
      "+hexists"
    )
    const partial = {
      eval: async (...args) => cli("--user", "partial", "-a", secret, "EVAL", ...args),
    }
    const interrupted = next(JSON.parse(reopen.anchor), "rebind", { intent: H("4") })
    await assert.rejects(applyTransition(partial, interrupted))
    assert.equal(cli("GET", SCAN_ADMISSION_KEY), receipt("12:1"))
    assert.equal(await inspectTransition(redis, interrupted), "unknown")
    cli("ACL", "SETUSER", "partial", "off", "-@all", "resetkeys")
    cli("FLUSHDB")
    await applyTransition(
      redis,
      prepareTransition(null, {
        operation: "acquire",
        epoch: H("5"),
        authority: H("e"),
        intent: H("6"),
        nextReceipt: receipt("12:1"),
      })
    )
    // Current deployed broad/default authority must never qualify.
    cli("ACL", "SETUSER", "runtime", ...runtimeAclRules(), ">" + secret)
    cli("ACL", "SETUSER", "writer", ...writerAclRules(), ">" + secret)
    await assert.rejects(
      verifyPairedRolePolicy(redis, { runtimeUser: "runtime", writerUser: "writer" })
    )
    cli(
      "ACL",
      "SETUSER",
      "auditor",
      "reset",
      "on",
      ">" + secret,
      "-@all",
      "+acl|users",
      "+acl|getuser",
      "+acl|dryrun"
    )
    cli("ACL", "SETUSER", "default", "off", "-@all", "resetkeys")
    const callAs = (user, ...args) => cli("--user", user, "-a", secret, ...args)
    const audit = { call: async (...args) => callAs("auditor", ...args) }
    const proof = await verifyPairedRolePolicy(audit, {
      runtimeUser: "runtime",
      writerUser: "writer",
    })
    assert.equal(proof.admissionReadOnly, true)
    assert.equal(callAs("runtime", "GET", SCAN_ADMISSION_KEY), receipt("12:1"))
    assert.throws(() => callAs("runtime", "SET", SCAN_ADMISSION_KEY, "bad"))
    assert.throws(() =>
      callAs("runtime", "EVAL", "return redis.call('DEL',KEYS[1])", 1, SCAN_ADMISSION_KEY)
    )
    assert.equal(callAs("runtime", "SET", "bull:scans:fixture", "ok"), "OK")
    assert.throws(() => callAs("writer", "SET", "bull:scans:fixture", "bad"))
    t.diagnostic(
      "actual same-slot cluster; one winner; retained unknowns and lease bounds; broad default denied; scoped runtime raw/Lua write denied"
    )
  }
)
