import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import {
  azureServingRoute,
  stageAtZeroTraffic,
  retirePreviousRevision,
  verifyZeroTrafficCandidate,
} from "../paired-runtime-cloud.mjs"

const d = "sha256:" + "a".repeat(64),
  e = "b".repeat(40)
const p = {
  productRevision: e,
  proxyDigest: d,
  relay: { previous: "proxy--old", candidate: "proxy--new" },
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "paired-live-fixture-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const oldEnv = {}
  function env(k, v) {
    if (!Object.hasOwn(oldEnv, k)) oldEnv[k] = process.env[k]
    process.env[k] = v
  }
  env("PATH", dir + ":" + process.env.PATH)
  env("RG", "rg")
  env("EGRESS_NAME", "proxy")
  env("RECORDER", dir)
  t.after(() => {
    for (const [k, v] of Object.entries(oldEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  const put = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value)),
    calls = () =>
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
      readFileSync(join(dir, "calls"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((s) => JSON.parse(s))
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  writeFileSync(join(dir, "calls"), "")
  return { dir, put, calls, env }
}
test("live Azure role commands stage zero, enforce image/scale/replicas, probe direct endpoint and reject false retirement", async (t) => {
  const { dir, put, calls } = fixture(t)
  const repo = "ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-egress-proxy@"
  const row = (name, active) => ({
    name,
    properties: {
      fqdn: name + ".east.azurecontainerapps.io",
      active,
      healthState: "Healthy",
      runningState: "Running",
      template: { scale: { minReplicas: 1, maxReplicas: 1 }, containers: [{ image: repo + d }] },
    },
  })
  const previous = row("proxy--old", true),
    candidate = row("proxy--new", true)
  const state = {
    rows: [previous],
    candidate,
    traffic: [{ revisionName: previous.name, weight: 100 }],
    other: false,
  }
  put("state", state)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  writeFileSync(
    join(dir, "az"),
    `#!/usr/bin/env node
const fs=require("node:fs"),root=process.env.RECORDER, a=process.argv.slice(2),path=root+"/state",state=JSON.parse(fs.readFileSync(path));fs.appendFileSync(root+"/calls",JSON.stringify(a)+"\\n")
const cmd=a.slice(0,3).join(" "),rev=a[a.indexOf("--revision")+1],row=state.rows.find(r=>r.name===rev);let out
if(a[1]==="show")out={properties:{configuration:{activeRevisionsMode:"Multiple"}}}
else if(cmd==="containerapp revision list")out=state.rows
else if(cmd==="containerapp revision show")out=row
else if(cmd==="containerapp ingress traffic")out=state.traffic
else if(cmd==="containerapp replica list")out=row.properties.active?[{name:"ready",properties:{containers:[{ready:true}]}}]:[]
else if(cmd==="containerapp revision copy"){state.rows.push(state.candidate);out=state.candidate}
else if(cmd==="containerapp revision deactivate"){row.properties.active=false;out=row}
else process.exit(19)
fs.writeFileSync(path,JSON.stringify(state));console.log(JSON.stringify(out))
`,
    { mode: 0o700 }
  )
  stageAtZeroTraffic("relay", p)
  const copy = calls().find((a) => a[2] === "copy")
  assert.equal(copy[copy.indexOf("--image") + 1], repo + d)
  assert.equal(copy[copy.indexOf("--from-revision") + 1], previous.name)
  assert.equal(copy[copy.indexOf("--max-replicas") + 1], "1")
  verifyZeroTrafficCandidate("relay", p)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  let s = JSON.parse(readFileSync(join(dir, "state")))
  s.traffic = [{ revisionName: candidate.name, weight: 100 }]
  put("state", s)
  retirePreviousRevision("relay", p)
  t.mock.method(globalThis, "fetch", async (uri) => {
    assert.equal(uri, "https://proxy--old.east.azurecontainerapps.io/health")
    return new Response("", { status: 404 })
  })
  const r = await azureServingRoute("relay", p)
  assert.equal(r.oldRevisionReachable, false)
  assert.equal(r.oldServingReplicas, 0)
  assert.equal(r.healthy, true)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  s = JSON.parse(readFileSync(join(dir, "state")))
  s.rows[1].properties.template.scale.maxReplicas = 2
  put("state", s)
  await assert.rejects(azureServingRoute("relay", p))
  s.rows[1].properties.template.scale.maxReplicas = 1
  s.traffic = [{ latestRevision: true, weight: 100 }]
  put("state", s)
  await assert.rejects(azureServingRoute("relay", p))
  assert.ok(!calls().some((a) => a[1] === "delete"))
})

test("sandbox staging executes only the pinned held pull and refuses low disk, digest/source/size drift or unsafe selector", (t) => {
  const { dir, env } = fixture(t)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  mkdirSync(join(dir, "ops", "worker"), { recursive: true })
  const config = join(dir, "worker.conf"),
    envFile = join(dir, "worker.env"),
    lock = join(dir, "lock")
  const worker = "ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@" + d,
    prior = "ghcr.io/ecryptoguru/lyrashield-sandbox@sha256:" + "c".repeat(64),
    next = "ghcr.io/ecryptoguru/lyrashield-sandbox@" + d
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  writeFileSync(
    config,
    "LYRASHIELD_WORKER_IMAGE=" +
      worker +
      "\nLYRASHIELD_SANDBOX_IMAGE=" +
      prior +
      "\nGHCR_USERNAME=test-user\n"
  )
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  writeFileSync(envFile, "GHCR_TOKEN=sensitive-test-value\n")
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  writeFileSync(join(dir, "ops/worker/worker-env.sh"), "lyrashield_worker_env_args(){ :; }\n")
  const pins = join(dir, "pins")
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  writeFileSync(pins, "redis.test 127.0.0.1 6379\n")
  const s = readFileSync(".github/scripts/paired-live-host.sh", "utf8")
    .replace(
      "loader=/opt/lyrashield-worker-host/worker-env.sh",
      "loader=" + join(dir, "ops/worker/worker-env.sh")
    )
    .replace("config=/etc/lyrashield/worker-runtime.conf", "config=" + config)
    .replace("env_file=/etc/lyrashield/worker.env", "env_file=" + envFile)
    .replace("pins=/run/lyrashield-egress-hosts", "pins=" + pins)
    .replace("/run/lyrashield/paired-runtime-operation.lock", lock)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  writeFileSync(join(dir, "host.sh"), s)
  env("TEST_REF", next)
  env("TEST_PRIOR", prior)
  env("TEST_ENGINE", e)
  const write = (name, body) =>
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
    writeFileSync(join(dir, name), "#!/bin/sh\nset -eu\n" + body, { mode: 0o700 })
  write("timeout", 'shift; case "$1" in *s) shift;; esac; exec "$@"')
  write(
    "systemctl",
    'case "$*" in *is-active*) echo inactive; exit 3;; *is-enabled*) echo disabled; exit 1;; *) exit 19;; esac'
  )
  write("flock", ":")
  write("stat", 'case "$2" in %u) echo 0;; %a) echo 600;; *) exit 19;; esac')
  write("df", 'printf "header\\n/dev/fake 0 0 %s 0 /\\n" "${TEST_BYTES:-9999999999}"')
  write(
    "docker",
    `echo "$*" >> "$RECORDER/docker-commands"
case "$1 $2" in
 "ps -a"|"ps --quiet") exit 0;;
 "run --rm") printf 1;;
 "info --format") case "$3" in *Architecture*) echo x86_64;; *) echo "$RECORDER";; esac;;
 "login ghcr.io") cat >/dev/null;;
 "pull "*) [ "$2" = "$TEST_REF" ]; touch "$RECORDER/pulled";;
 "image inspect")
  if [ "$3" = "$TEST_PRIOR" ]; then echo old-config-id;exit 0;fi
  [ "$3" = "$TEST_REF" ] && [ -e "$RECORDER/pulled" ] || exit 1
  case "\${5:-}" in *RepoDigests*) echo "\${DRIFT_DIGEST:-$TEST_REF}";; *Size*) echo "\${DRIFT_SIZE:-12345}";; *revision*) echo "\${DRIFT_SOURCE:-$TEST_ENGINE}";; esac;;
 *) exit 18;;esac`
  )
  const arg = Buffer.from(
    JSON.stringify({
      receipt: "opaque",
      sandboxDigest: d,
      engineRevision: e,
      priorWorkerDigest: d,
      amd64Bytes: 12345,
      arm64Bytes: 12000,
    })
  ).toString("base64")
  const run = (action, over = {}) =>
    spawnSync("sh", [join(dir, "host.sh"), action, arg, dir], {
      encoding: "utf8",
      env: { ...process.env, ...over },
      timeout: 12000,
    })
  assert.notEqual(run("stage-sandbox", { TEST_BYTES: "10" }).status, 0)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  assert.ok(!/^pull /m.test(readFileSync(join(dir, "docker-commands"), "utf8")))
  const pass = run("stage-sandbox")
  assert.equal(pass.status, 0, pass.stderr)
  assert.equal(pass.stdout, "true")
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  const logs = readFileSync(join(dir, "docker-commands"), "utf8")
  assert.ok(logs.includes("pull " + next) && !logs.includes("sensitive-test-value"))
  for (const bad of [{ DRIFT_SOURCE: "bad" }, { DRIFT_SIZE: "bad" }, { DRIFT_DIGEST: prior }])
    assert.notEqual(run("stage-sandbox", bad).status, 0)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  writeFileSync(config + ".evidence-writer-canary", "private")
  assert.notEqual(run("selector-absent").status, 0)
})

test("live replica verifier executes fixed read in a PTY, never echoes connection strings, refuses missing proof", (t) => {
  const { dir } = fixture(t)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  writeFileSync(
    join(dir, "az"),
    `#!/usr/bin/env python3
import os,sys,subprocess
sys.stdout.write("Use ctrl + D to exit.\\n");sys.stdout.flush()
command=sys.stdin.readline()
if os.environ.get("TEST_NO_PROOF"):sys.exit(0)
assert command.startswith('node -e "') and 'PAIR_CONN_' in command
subprocess.run(["sh","-c",command],check=True)
`,
    { mode: 0o700 }
  )
  const nonce = "c".repeat(64),
    args = [
      "-I",
      ".github/scripts/paired-live-replica.py",
      "rg",
      "app",
      "app--current",
      "app--current-1",
      "web",
      nonce,
    ]
  const env = {
    ...process.env,
    DATABASE_URL: "test-database-sensitive",
    REDIS_URL: "test-redis-sensitive",
  }
  const verified = spawnSync("python3", args, { encoding: "utf8", env, timeout: 8000 })
  assert.equal(verified.status, 0, verified.stderr)
  assert.match(verified.stdout, /^[a-f0-9]{64} [a-f0-9]{64}\n$/)
  const bad = spawnSync("python3", args, {
    encoding: "utf8",
    env: { ...env, TEST_NO_PROOF: "1" },
    timeout: 8000,
  })
  assert.notEqual(bad.status, 0)
  assert.ok(!(bad.stdout + bad.stderr).includes("sensitive"))
})

test("historical promotion fetches the exact qualified Git object in isolation and invokes that source wrapper", async (t) => {
  const { dir, env } = fixture(t),
    original = process.env.PATH.split(":").slice(1).join(":")
  const realGit = spawnSync("sh", ["-c", "command -v git"], {
    env: { ...process.env, PATH: original },
    encoding: "utf8",
  }).stdout.trim()
  const repo = join(dir, "fixture-repo")
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  mkdirSync(repo)
  const git = (...args) => {
    const r = spawnSync(realGit, ["-C", repo, ...args], { encoding: "utf8" })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  git("init", "-q")
  git("config", "user.name", "fixture")
  git("config", "user.email", "fixture@example.test")
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  mkdirSync(join(repo, ".github/scripts"), { recursive: true })
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  writeFileSync(
    join(repo, ".github/scripts/paired-runtime-vm.sh"),
    '#!/bin/sh\nset -eu\ncd "$(dirname "$0")/../.."\n[ "$(git rev-parse HEAD)" = "$2" ]\nprintf "%s\\n" "$2" "$9" > "$RECORDER/promoted"\n'
  )
  git("add", ".")
  git("commit", "-qm", "qualified A")
  const a = git("rev-parse", "HEAD")
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  writeFileSync(join(repo, "next"), "new")
  git("add", ".")
  git("commit", "-qm", "B")
  const b = git("rev-parse", "HEAD")
  env("TEST_GIT", realGit)
  env("TEST_REPO", repo)
  env("TEST_SOURCE_A", a)
  env("TEST_SOURCE_B", b)
  env("AZURE_APP_SECRET_KEY_VAULT_NAME", "test-vault")
  env("WORKER_VM_NAME", "worker")
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  writeFileSync(
    join(dir, "gh"),
    '#!/usr/bin/env node\nconst s=process.env;const route=process.argv.at(-1);if(route!=="repos/ecryptoguru/lyrashield-ai/compare/"+s.TEST_SOURCE_A+"..."+s.TEST_SOURCE_B+"?per_page=1")process.exit(10);console.log(JSON.stringify({status:"ahead",merge_base_commit:{sha:s.TEST_SOURCE_A}}))',
    { mode: 0o700 }
  )
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  writeFileSync(
    join(dir, "git"),
    '#!/usr/bin/env node\nconst fs=require("node:fs"),s=process.env;let a=process.argv.slice(2);if(a.join(" ")==="--no-replace-objects rev-parse HEAD"){console.log(s.TEST_SOURCE_B);process.exit(0)};if(a.includes("fetch")){const i=a.indexOf("https://github.com/ecryptoguru/lyrashield-ai.git");if(i<0||a.at(-1)!==s.TEST_SOURCE_A||!a.includes("--depth=1"))process.exit(20);a[i]="file://"+s.TEST_REPO};const r=require("node:child_process").spawnSync(s.TEST_GIT,a,{stdio:"inherit"});process.exit(r.status)',
    { mode: 0o700 }
  )
  const { promoteStoppedWorker } = await import("../paired-runtime-cloud.mjs")
  promoteStoppedWorker({
    owner: "42:1",
    productRevision: a,
    engineRevision: e,
    workerDigest: d,
    priorWorkerDigest: d,
    sandboxDigest: d,
  })
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  assert.deepEqual(readFileSync(join(dir, "promoted"), "utf8").trim().split("\n"), [a, d])
  assert.equal(git("rev-parse", "HEAD"), b)
})
