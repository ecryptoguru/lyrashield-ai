import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "v26-vm-transport-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const write = (name, body) => {
    const path = join(directory, name)
    // All fixture files are in this test's freshly created directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(path, body)
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    chmodSync(path, 0o755)
  }
  for (const [name, source] of [
    ["v26-vm.sh", new URL("../v26-vm.sh", import.meta.url)],
    ["worker-env.sh", new URL("../../../ops/worker/worker-env.sh", import.meta.url)],
    ["v26-execution-drain.sh", new URL("../v26-execution-drain.sh", import.meta.url)],
  ]) {
    // These are fixed, source-controlled transport files.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    write(name, readFileSync(source, "utf8"))
  }
  const digest = `sha256:${randomBytes(32).toString("hex")}`
  const source = randomBytes(20).toString("hex")
  const image = `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker:${source}@${digest}`
  write(
    "runtime.conf",
    `LYRASHIELD_WORKER_IMAGE=${image}\nLYRASHIELD_SANDBOX_IMAGE=fixture@${digest}\n`
  )
  write("worker.env", "")
  write(
    "pins",
    "db.example 192.0.2.10 5432\ndb.example 192.0.2.11 5432\nredis.example 192.0.2.12 6379\n"
  )
  write("flock", "#!/bin/sh\nexit 0\n")
  write("stat", "#!/bin/sh\ncase \"$*\" in *%u:%a*) printf '0:600\\n';; *) printf '0\\n';; esac\n")
  write("timeout", '#!/bin/sh\ncase "$1" in --kill-after=*) shift;; esac\nshift\nexec "$@"\n')
  write(
    "systemctl",
    `#!/bin/sh
case "$1" in
  is-active)
    if [ "$TRANSPORT_STOPPED" = 1 ]; then echo inactive; exit 3; fi
    exit 0;;
  is-enabled) echo disabled; exit 1;;
  *) exit 0;;
esac
`
  )
  write(
    "docker",
    `#!${process.execPath}
const fs=require("node:fs"),{spawnSync}=require("node:child_process");
const args=process.argv.slice(2); fs.appendFileSync(process.env.TRANSPORT_LOG,JSON.stringify(args)+"\\n");
if(args[0]==="image"){console.log(${JSON.stringify(source)});process.exit(0)}
if(args[0]==="inspect"){console.log(args.some(value=>value.includes("State.Health"))?"healthy":process.env.TRANSPORT_IMAGE);process.exit(0)}
if(args[0]==="exec"){console.log(JSON.stringify({databaseUrlSha256:"fixture-hash",databaseSystemUrlSha256:"fixture-hash",redisUrlSha256:"fixture-hash"}));process.exit(0)}
if(args[0]==="ps")process.exit(0);
if(args[0]!=="run")process.exit(1);
if(args.includes("none"))process.exit(0);
const action=args[args.indexOf("/v26/v26-vm-state.mjs")+1];
const stop=args.find(value=>value.includes("dst=/v26-stop"));
if(stop&&!fs.existsSync(process.env.TRANSPORT_STOP_DIRECTORY)){console.error("bind source absent");process.exit(1)}
if(action==="quiesced"&&!fs.existsSync(process.env.TRANSPORT_STOP_RECEIPT)){console.error("fresh stop receipt absent");process.exit(1)}
if(action==="probe")console.log("V26_PRIVATE="+Buffer.from(JSON.stringify({worker:{databaseUrlSha256:"fixture-hash",databaseSystemUrlSha256:"fixture-hash",redisUrlSha256:"fixture-hash"},receipt:null})).toString("base64"));
console.log("V26_PHASE_OK="+action);
`
  )
  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    TRANSPORT_LOG: join(directory, "docker.jsonl"),
    TRANSPORT_IMAGE: image,
    TRANSPORT_STOPPED: "0",
    TRANSPORT_STOP_DIRECTORY: join(directory, "absent-run-directory"),
    TRANSPORT_STOP_RECEIPT: join(directory, "absent-run-directory/worker-stop-provenance.json"),
    LYRASHIELD_WORKER_RUNTIME_CONFIG: join(directory, "runtime.conf"),
    LYRASHIELD_WORKER_ENV_FILE: join(directory, "worker.env"),
    LYRASHIELD_V26_STATE_DIR: directory,
    LYRASHIELD_EGRESS_PIN_FILE: join(directory, "pins"),
  }
  const run = (phase) =>
    spawnSync(
      "sh",
      [
        join(directory, "v26-vm.sh"),
        phase,
        Buffer.from("{}").toString("base64"),
        Buffer.from("{}").toString("base64"),
      ],
      { env, encoding: "utf8", timeout: 20000 }
    )
  return {
    env,
    write,
    run,
    argv: () => {
      // Only the fixture-owned command log is read.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      return readFileSync(env.TRANSPORT_LOG, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    },
  }
}
test("actual v26 VM shell preserves committed DNS pins for every networked oneshot and probes before a first stop", (t) => {
  const f = fixture(t)
  // The expected-absent path is confined to this test’s disposable directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  assert.equal(existsSync(f.env.TRANSPORT_STOP_DIRECTORY), false)
  for (const phase of [
    "probe",
    "claim",
    "owned",
    "queues",
    "inventory",
    "migration-intent",
    "migrated",
    "verify",
    "release",
  ]) {
    f.env.TRANSPORT_STOPPED = ["inventory", "migration-intent", "migrated"].includes(phase)
      ? "1"
      : "0"
    const result = f.run(phase)
    assert.equal(result.status, 0, `${phase}: ${result.stdout}\n${result.stderr}`)
  }
  const calls = f.argv().filter((args) => args[0] === "run" && args.includes("bridge"))
  assert.ok(calls.length >= 9)
  for (const args of calls) {
    assert.ok(args.includes("db.example:192.0.2.10"))
    assert.ok(args.includes("db.example:192.0.2.11"))
    assert.ok(args.includes("redis.example:192.0.2.12"))
    assert.equal(args.filter((value) => value === "--add-host").length, 3)
    assert.equal(
      args.some((value) => value.includes("dst=/v26-stop")),
      false
    )
  }
  // The expected-absent path is confined to this test’s disposable directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  assert.equal(existsSync(f.env.TRANSPORT_STOP_DIRECTORY), false)
  f.env.TRANSPORT_STOPPED = "1"
  const blocked = f.run("quiesced")
  assert.notEqual(blocked.status, 0)
  assert.doesNotMatch(blocked.stdout, /V26_PHASE_OK=quiesced/)
  const stoppedCall = f.argv().findLast((args) => args.includes("quiesced"))
  assert.ok(stoppedCall.some((value) => value.includes("dst=/v26-stop")))
})
test("actual v26 VM shell refuses missing or malformed committed pins without launching a networked probe", (t) => {
  for (const pins of [
    "",
    "db.example 192.0.2.10 invalid\n",
    "db.example 192.0.2.10 5432 unexpected\n",
  ]) {
    const f = fixture(t)
    f.write("pins", pins)
    assert.notEqual(f.run("probe").status, 0)
    assert.equal(
      f.argv().some((args) => args[0] === "run" && args.includes("bridge")),
      false
    )
  }
})
