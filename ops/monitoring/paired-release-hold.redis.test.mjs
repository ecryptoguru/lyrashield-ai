/** Opt-in real Lua regression, only against an explicitly supplied isolated test container. */
import assert from "node:assert/strict"
import { execFile, execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { fileURLToPath } from "node:url"

const container = process.env.LYRASHIELD_OWNED_HOLD_REDIS_CONTAINER
const key = "lyrashield:scan-admission:stopped"
const identity = ["123:1", "a".repeat(40), "b".repeat(40), `sha256:${"c".repeat(64)}`]
const root = fileURLToPath(new URL("../../", import.meta.url))
const execute = promisify(execFile)

test(
  "real Redis owned/manual receipt boundaries and concurrent Lua CAS",
  { skip: !container },
  async (t) => {
    assert.match(container, /^[a-f0-9]{64}$/)
    const info = JSON.parse(
      execFileSync("docker", ["inspect", container], { encoding: "utf8", timeout: 10000 })
    )[0]
    assert.equal(info.Config.Labels["io.lyrashield.test-scope"], "owned-hold")
    assert.equal(info.HostConfig.NetworkMode, "none")
    assert.equal(info.HostConfig.Memory, 268435456)
    assert.equal(info.HostConfig.NanoCpus, 500000000)
    assert.ok(
      !info.HostConfig.PortBindings || Object.keys(info.HostConfig.PortBindings).length === 0
    )
    assert.ok(info.Mounts.every((mount) => mount.Type === "tmpfs"))
    const cli = (...args) =>
      execFileSync("docker", ["exec", container, "redis-cli", "-n", "15", "--raw", ...args], {
        encoding: "utf8",
        timeout: 10000,
      }).trim()
    const directory = mkdtempSync(path.join(tmpdir(), "owned-hold-real-redis-"))
    t.after(() => {
      cli("DEL", key)
      rmSync(directory, { recursive: true, force: true })
    })
    writeFileSync(
      path.join(directory, "redis-cli"),
      `#!/usr/bin/env node
const {spawnSync}=require("node:child_process");
const args=process.argv.slice(2); const index=args.indexOf("-u");
if(index<0||args[index+1]!=="redis://owned-hold.fixture/15")process.exit(2);
args.splice(index,2);
const result=spawnSync("docker",["exec",process.env.LYRASHIELD_OWNED_HOLD_REDIS_CONTAINER,"redis-cli","-n","15",...args],{stdio:"inherit",timeout:10000});
process.exit(result.status??1);
`
    )
    chmodSync(path.join(directory, "redis-cli"), 0o755)
    const operation = async (command, args = identity) => {
      try {
        const result = await execute("sh", ["ops/monitoring/scan-admission.sh", command, ...args], {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            REDIS_URL: "redis://owned-hold.fixture/15",
          },
          timeout: 15000,
        })
        return { code: 0, ...result }
      } catch (error) {
        return { code: error.code, stdout: error.stdout, stderr: error.stderr }
      }
    }

    await t.test(
      "different racing owners have one persistent winner; only exact owner can release",
      async () => {
        cli("DEL", key)
        const other = ["124:1", ...identity.slice(1)]
        const results = await Promise.all([
          operation("claim-owned"),
          operation("claim-owned", other),
        ])
        assert.deepEqual(results.map((result) => result.code).sort(), [0, 1])
        const winner = results[0].code === 0 ? identity : other
        const receipt = cli("GET", key)
        assert.equal(cli("PTTL", key), "-1")
        for (const args of [
          ["125:1", ...identity.slice(1)],
          [winner[0], "f".repeat(40), ...identity.slice(2)],
          [winner[0], identity[1], "f".repeat(40), identity[3]],
          [...winner.slice(0, 3), `sha256:${"f".repeat(64)}`],
        ]) {
          assert.notEqual((await operation("release-owned", args)).code, 0)
          assert.equal(cli("GET", key), receipt)
        }
        assert.equal((await operation("assert-owned", winner)).code, 0)
        assert.equal((await operation("release-owned", winner)).code, 0)
        assert.equal(cli("EXISTS", key), "0")
      }
    )

    await t.test("ordinary, external and malformed stops cannot be manually resumed", async () => {
      const values = [
        { operator: "github-actions", reason: "worker-promotion", at: "2026-11-03T00:00:00.000Z" },
        { operator: "on-call" },
        { operator: "on-call", reason: "incident", stoppedAt: "invalid" },
        { operator: "on-call", reason: "incident", stoppedAt: "2026-02-30T00:00:00.000Z" },
        { operator: "on-call", reason: "incident", stoppedAt: "2026-99-03T00:00:00.000Z" },
        {
          operator: "on-call",
          reason: "incident",
          stoppedAt: "2026-11-03T00:00:00.000Z",
          extra: true,
        },
        { operator: "github-actions", reason: "webhook-claims-cutover", owner: "123:1" },
      ]
      for (const value of values) {
        const raw = JSON.stringify(value)
        cli("SET", key, raw)
        assert.notEqual((await operation("resume", [value.operator])).code, 0)
        assert.equal(cli("GET", key), raw)
      }
      cli("SET", key, "not-json")
      assert.notEqual((await operation("resume", ["on-call"])).code, 0)
      assert.equal(cli("GET", key), "not-json")
    })

    await t.test(
      "accepted manual reasons are releasable; automated reasons are rejected before creation",
      async () => {
        for (const reason of ["incident", "queue_uncertain", "operator maintenance"]) {
          cli("DEL", key)
          assert.equal((await operation("stop", ["on-call", reason])).code, 0)
          assert.notEqual((await operation("resume", ["foreign"])).code, 0)
          assert.equal((await operation("resume", ["on-call"])).code, 0)
          assert.equal(cli("EXISTS", key), "0")
        }
        for (const reason of [
          "paired-release",
          "worker-promotion",
          "webhook-claims-cutover",
          "v26-accounting-cutover",
        ]) {
          cli("DEL", key)
          assert.notEqual((await operation("stop", ["on-call", reason])).code, 0)
          assert.equal(cli("EXISTS", key), "0")
        }
      }
    )

    await t.test("raw duplicate keys, option-like names and legacy manual reasons", async () => {
      cli("DEL", key)
      assert.equal((await operation("stop", ["--version", "incident"])).code, 0)
      assert.equal((await operation("resume", ["--version"])).code, 0)
      for (const reason of [
        "paired-release",
        "worker-promotion",
        "webhook-claims-cutover",
        "v26-accounting-cutover",
      ]) {
        cli(
          "SET",
          key,
          JSON.stringify({ operator: "on-call", reason, stoppedAt: "2026-11-03T00:00:00.000Z" })
        )
        assert.equal((await operation("resume", ["on-call"])).code, 0)
      }
      cli(
        "SET",
        key,
        JSON.stringify({
          operator: "on-call",
          reason: "x".repeat(4096),
          stoppedAt: "2026-11-03T00:00:00.000Z",
        })
      )
      assert.equal((await operation("resume", ["on-call"])).code, 0)
      const duplicate =
        '{"operator":"on-call","reason":"paired-release","reason":"incident","stoppedAt":"2026-11-03T00:00:00.000Z"}'
      cli("SET", key, duplicate)
      assert.notEqual((await operation("resume", ["on-call"])).code, 0)
      assert.equal(cli("GET", key), duplicate)
      cli("DEL", key)
      assert.notEqual((await operation("stop", ["on-call", "x".repeat(4096)])).code, 0)
      assert.equal(cli("EXISTS", key), "0")
    })

    await t.test(
      "expiry is rejected and interleaved replacement can never be deleted",
      async () => {
        cli("DEL", key)
        assert.equal((await operation("claim-owned")).code, 0)
        cli("PEXPIRE", key, "60000")
        for (const name of ["claim-owned", "assert-owned", "release-owned"])
          assert.notEqual((await operation(name)).code, 0)
        assert.ok(Number(cli("PTTL", key)) > 0)
        cli("PERSIST", key)
        assert.equal((await operation("release-owned")).code, 0)
        for (let index = 0; index < 8; index++) {
          cli("DEL", key)
          assert.equal((await operation("claim-owned")).code, 0)
          const foreign = JSON.stringify({ operator: "incident", reason: `external-${index}` })
          await Promise.all([
            operation("release-owned"),
            execute("docker", ["exec", container, "redis-cli", "-n", "15", "SET", key, foreign]),
          ])
          assert.equal(cli("GET", key), foreign)
        }
      }
    )
  }
)
