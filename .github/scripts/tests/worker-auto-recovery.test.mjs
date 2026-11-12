import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import {
  assertRecoveryDatabase,
  RECOVERY_UNKNOWN_SQL,
} from "../../../ops/worker/worker-recovery-probe.mjs"

const epoch = "1790000000.123456"
const hash = createHash("sha256").update(epoch).digest("hex")
test("automatic recovery accepts only the original epoch and unambiguous paid effects", async () => {
  const query = async (sql) => ({
    rows: sql === RECOVERY_UNKNOWN_SQL ? [{ unknown: false }] : [{ epoch }],
  })
  await assertRecoveryDatabase({ query, expected: hash })
  await assert.rejects(assertRecoveryDatabase({ query, expected: "a".repeat(64) }), /changed/)
  await assert.rejects(
    assertRecoveryDatabase({
      query: async () => {
        throw new Error("database unavailable")
      },
      expected: hash,
    }),
    /unavailable/
  )
  await assert.rejects(
    assertRecoveryDatabase({
      query: async (sql) => ({
        rows: sql === RECOVERY_UNKNOWN_SQL ? [{ unknown: true }] : [{ epoch }],
      }),
      expected: hash,
    }),
    /held/
  )
})

function fixture(t, scenario = "") {
  const directory = mkdtempSync(join(tmpdir(), "worker-auto-recovery-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const assets = join(directory, "assets"),
    bin = join(directory, "bin"),
    state = join(directory, "state")
  for (const path of [assets, bin, state]) mkdirSync(path)
  const log = join(directory, "log")
  writeFileSync(log, "")
  const config = join(directory, "runtime.conf")
  const configValue = `LYRASHIELD_COLD_SINGLE_WORKER=1\nLYRASHIELD_COLD_DATABASE_EPOCH_SHA256=${hash}\nLYRASHIELD_WORKER_IMAGE=ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@sha256:${"a".repeat(64)}\nLYRASHIELD_SANDBOX_IMAGE=ghcr.io/ecryptoguru/lyrashield-sandbox@sha256:${"b".repeat(64)}\n`
  writeFileSync(config, configValue)
  writeFileSync(join(directory, "worker.env"), "")
  writeFileSync(join(directory, "pins"), "database.fixture 127.0.0.1 5432\n")
  writeFileSync(
    join(assets, "worker-env.sh"),
    'lyrashield_worker_env_args() { printf "%s\\n" "--env FIXTURE=1"; }\n'
  )
  writeFileSync(
    join(assets, "cold-start-barrier.py"),
    'import os\nwith open(os.environ["RECOVERY_LOG"], "a") as stream: stream.write("native barrier\\n")\n'
  )
  const executable = (name, source) => writeFileSync(join(bin, name), source, { mode: 0o700 })
  executable(
    "cat",
    '#!/bin/sh\ncase "$1" in /proc/sys/kernel/random/uuid) echo 11111111-1111-4111-8111-111111111111 ;; *) exec /bin/cat "$@" ;; esac\n'
  )
  executable("stat", '#!/bin/sh\ncase "$*" in */state) echo 0:700 ;; *) echo 0:600 ;; esac\n')
  executable("flock", "#!/bin/sh\nexit 0\n")
  executable("sync", "#!/bin/sh\nexit 0\n")
  executable("sleep", "#!/bin/sh\nexit 0\n")
  executable("timeout", '#!/bin/sh\ncase "$1" in --kill-after=*) shift;; esac\nshift\nexec "$@"\n')
  executable(
    "systemctl",
    '#!/bin/sh\nprintf "systemctl %s\\n" "$*" >> "$RECOVERY_LOG"\n[ "$RECOVERY_SCENARIO" != start-failed ] || [ "$*" != "start lyrashield-worker.service" ]\n'
  )
  executable(
    "docker",
    `#!/usr/bin/env python3
import os,sys
from pathlib import Path
args=sys.argv[1:]
with open(os.environ['RECOVERY_LOG'],'a') as stream:
 if args[0]=='run':
  phase=args[-2]
  stream.write('probe '+phase+'\\n')
  assert 'LYRASHIELD_COLD_SINGLE_WORKER=1' in args
  assert 'LYRASHIELD_COLD_DATABASE_EPOCH_SHA256='+os.environ['RECOVERY_EXPECTED_EPOCH'] in args
  Path(args[args.index('--cidfile')+1]).write_text('c'*64)
  scenario=os.environ['RECOVERY_SCENARIO']
  if scenario=='foreign-stop' or (scenario in ('epoch-changed','unquarantined-effect') and phase!='claim'): sys.exit(1)
 elif args[0]=='inspect': print('unhealthy' if os.environ['RECOVERY_SCENARIO']=='unhealthy' else 'healthy')
 elif args[0]=='rm': stream.write('owned probe removed\\n')
`
  )
  const runner = join(directory, "recover-worker.sh")
  writeFileSync(
    runner,
    readFileSync("ops/worker/recover-worker.sh", "utf8").replaceAll(
      "/var/lib/lyrashield/worker-cold-start",
      state
    )
  )
  return {
    config,
    configValue,
    state,
    log,
    run: (override = {}) =>
      spawnSync("sh", [runner], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: bin + ":" + process.env.PATH,
          RECOVERY_LOG: log,
          RECOVERY_EXPECTED_EPOCH: hash,
          RECOVERY_SCENARIO: scenario,
          LYRASHIELD_WORKER_RUNTIME_CONFIG: config,
          LYRASHIELD_WORKER_ENV_FILE: join(directory, "worker.env"),
          LYRASHIELD_EGRESS_PIN_FILE: join(directory, "pins"),
          LYRASHIELD_WORKER_HOST_ASSETS_DIR: assets,
          LYRASHIELD_WORKER_COLD_START_DIR: state,
          ...override,
        },
      }),
  }
}

test("automatic restart runs guarded native barrier and retains the original protected pin", (t) => {
  const f = fixture(t)
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  const log = readFileSync(f.log, "utf8")
  assert.ok(log.indexOf("probe claim") < log.indexOf("native barrier"))
  assert.ok(log.indexOf("native barrier") < log.indexOf("probe release"))
  assert.ok(log.indexOf("probe release") < log.indexOf("systemctl start lyrashield-worker.service"))
  assert.equal(readFileSync(f.config, "utf8"), f.configValue)
  assert.equal(existsSync(join(f.state, "recovery-stop.json")), false)
})
for (const scenario of [
  "epoch-changed",
  "unquarantined-effect",
  "foreign-stop",
  "start-failed",
  "unhealthy",
]) {
  test(`automatic restart remains held for ${scenario}`, (t) => {
    const f = fixture(t, scenario)
    assert.notEqual(f.run().status, 0)
    const log = readFileSync(f.log, "utf8")
    assert.equal(readFileSync(f.config, "utf8"), f.configValue)
    assert.equal(existsSync(join(f.state, "recovery-stop.json")), true)
    if (["epoch-changed", "unquarantined-effect", "foreign-stop"].includes(scenario)) {
      assert.ok(!log.includes("systemctl start lyrashield-worker.service"))
      if (scenario === "foreign-stop") assert.ok(!log.includes("native barrier"))
      else assert.ok(log.includes("native barrier"))
    }
  })
}

test("recovery unit is independent of Docker cancellation and bounds repeated failures", () => {
  const worker = readFileSync("ops/worker/lyrashield-worker.service", "utf8")
  const recovery = readFileSync("ops/worker/lyrashield-worker-recover.service", "utf8")
  assert.match(worker, /OnFailure=lyrashield-worker-recover.service/)
  assert.match(worker, /Restart=always/)
  assert.doesNotMatch(recovery, /Requires=.*docker|After=.*docker/)
  assert.match(recovery, /StartLimitBurst=3/)
  assert.match(recovery, /Restart=no/)
})

test("a claimed old job is never replayed after service recovery permits other work", async () => {
  const { requireUnclaimedScan, ScanBillableClaimError } =
    await import("../../../packages/db/src/scan-billable-claim.ts")
  const retained = { status: "RUNNING", events: [{ id: "persisted-billable-marker" }] }
  const heldReservation = { state: "REVIEW_REQUIRED", stoppedAt: null }
  const before = JSON.stringify({ retained, heldReservation })
  const query = async (sql) => ({
    rows: sql === RECOVERY_UNKNOWN_SQL ? [{ unknown: false }] : [{ epoch }],
  })
  await assertRecoveryDatabase({ query, expected: hash })
  let providerStarts = 0
  const tx = { $executeRaw: async () => 1, scan: { findFirst: async () => retained } }
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(async () => {
      await requireUnclaimedScan(tx, "workspace", "old-scan")
      providerStarts++
    }, ScanBillableClaimError)
  }
  assert.equal(providerStarts, 0)
  assert.equal(JSON.stringify({ retained, heldReservation }), before)
})

test("recovery denies a divergent cold-state path before native effects", (t) => {
  const f = fixture(t)
  assert.notEqual(f.run({ LYRASHIELD_WORKER_COLD_START_DIR: "/different-state" }).status, 0)
  assert.equal(readFileSync(f.log, "utf8"), "")
})
