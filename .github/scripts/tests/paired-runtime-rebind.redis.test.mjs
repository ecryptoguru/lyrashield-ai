import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import test from "node:test"
import { rebindReceipt, observeRebind, releaseWithinLease } from "../paired-runtime-authority.mjs"
import {
  pairedReleaseReceipt,
  SCAN_ADMISSION_KEY,
} from "../../../ops/monitoring/paired-release-hold.mjs"

const cid = process.env.PAIRED_RECOVERY_TEST_REDIS_CONTAINER
test(
  "one-key rebind and armed release on isolated Redis",
  { skip: !cid, timeout: 45_000 },
  async (t) => {
    const exec = promisify(execFile)
    assert.match(cid, /^[a-f0-9]{64}$/)
    const [meta] = JSON.parse((await exec("docker", ["inspect", cid])).stdout)
    assert.equal(meta.Config.Labels["com.lyrashield.drill"], "paired-recovery-arm")
    assert.equal(meta.HostConfig.NetworkMode, "none")
    assert.ok(meta.Name.startsWith("/strix-paired-rebind-"))
    const cli = async (...cmd) =>
      JSON.parse(
        (
          await exec("docker", ["exec", cid, "redis-cli", "--json", ...cmd.map(String)], {
            timeout: 5000,
          })
        ).stdout
      )
    const redis = { eval: async (...args) => cli("EVAL", ...args) }
    const old = {
      owner: "10:1",
      productRevision: "a".repeat(40),
      engineRevision: "b".repeat(40),
      workerDigest: "sha256:" + "c".repeat(64),
    }
    const dest = { ...old, owner: "11:1", productRevision: "e".repeat(40) },
      other = { ...dest, owner: "12:1" }
    const receipt = (p) =>
      pairedReleaseReceipt(p.owner, p.productRevision, p.engineRevision, p.workerDigest)
    assert.equal(await cli("DBSIZE"), 0)
    await assert.rejects(rebindReceipt(redis, old, dest))
    await cli("SET", SCAN_ADMISSION_KEY, receipt(other))
    await assert.rejects(rebindReceipt(redis, old, dest))
    await cli("SET", SCAN_ADMISSION_KEY, receipt(old), "PX", 30000)
    await assert.rejects(rebindReceipt(redis, old, dest))
    await cli("SET", SCAN_ADMISSION_KEY, receipt(old))
    const wins = await Promise.allSettled([
      rebindReceipt(redis, old, dest),
      rebindReceipt(redis, old, other),
    ])
    assert.equal(wins.filter((x) => x.status === "fulfilled").length, 1)
    const winner = wins[0].status === "fulfilled" ? dest : other
    assert.equal(await observeRebind(redis, old, winner), "destination")
    assert.equal(await cli("PTTL", SCAN_ADMISSION_KEY), -1)
    await assert.rejects(rebindReceipt(redis, old, winner))
    const [seconds, usec] = await cli("TIME"),
      now = Number(seconds) * 1000 + Math.floor(Number(usec) / 1000)
    for (const lease of [
      { issuedAtMs: now - 60000, expiresAtMs: now - 1 },
      { issuedAtMs: now + 60000, expiresAtMs: now + 180000 },
      { issuedAtMs: now - 100000, expiresAtMs: now + 10000 },
    ]) {
      await assert.rejects(releaseWithinLease(redis, winner, lease))
      assert.equal(await cli("GET", SCAN_ADMISSION_KEY), receipt(winner))
      assert.equal(await cli("PTTL", SCAN_ADMISSION_KEY), -1)
    }
    const valid = { issuedAtMs: now - 10000, expiresAtMs: now + 120000 }
    await assert.rejects(releaseWithinLease(redis, old, valid))
    await cli("PEXPIRE", SCAN_ADMISSION_KEY, 60000)
    await assert.rejects(releaseWithinLease(redis, winner, valid))
    await cli("PERSIST", SCAN_ADMISSION_KEY)
    await releaseWithinLease(redis, winner, valid)
    await assert.rejects(releaseWithinLease(redis, winner, valid))
    assert.equal(await cli("EXISTS", SCAN_ADMISSION_KEY), 0)
    t.diagnostic(
      "Missing/foreign/expiring refused; exactly one competitor replaced the original persistent value. Redis TIME rejected expired, future and short leases before one exact-owner DEL."
    )
  }
)
