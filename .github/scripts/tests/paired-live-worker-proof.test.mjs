import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
const worker = "ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@sha256:" + "a".repeat(64)
const sandbox = "ghcr.io/ecryptoguru/lyrashield-sandbox@sha256:" + "c".repeat(64),
  id = "1".repeat(64),
  other = "2".repeat(64)
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "paired-worker-read-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  function put(name, body, mode = 0o600) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- private fixture path
    writeFileSync(join(dir, name), body, { mode })
  }
  const config = join(dir, "config"),
    envFile = join(dir, "env"),
    sibling = config + ".evidence-writer-canary"
  const shell = readFileSync(".github/scripts/paired-live-host.sh", "utf8")
    .replace("/proc/1/cmdline", join(dir, "cmdline"))
    .replace("/etc/lyrashield/worker-runtime.conf", config)
    .replace("/etc/lyrashield/worker.env", envFile)
    .replace("/opt/lyrashield-worker-host/worker-env.sh", join(dir, "loader"))
    .replace("/run/lyrashield-egress-hosts", join(dir, "pins"))
    .replace("/run/lyrashield/paired-runtime-operation.lock", join(dir, "lock"))
  put("host.sh", shell)
  put("env", "DATABASE_URL=private-fixture\n")
  put("pins", "redis.test 127.0.0.1 6379\n")
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private fixture path
  mkdirSync(join(dir, ".github/scripts"), { recursive: true })
  put(".github/scripts/v26-execution-drain.sh", "echo V26_EXECUTION_DRAIN_VERIFIED\n")
  // Use the source loader for current flags. The optional fixture wrapper
  // projects B's separately qualified sibling as a Docker --env-file.
  const loader = readFileSync("ops/worker/worker-env.sh", "utf8")
  put(
    "loader",
    loader.replace("lyrashield_worker_env_args()", "native_loader()") +
      '\nlyrashield_worker_env_args(){native_loader "$@" || return 1; if [ "${SELECTOR_AWARE:-0}" = 1 ] && [ -f "$1.evidence-writer-canary" ]; then printf "%s\\n" "--env-file $1.evidence-writer-canary"; fi; }\n'.replace(
        "(){native",
        "(){ native"
      )
  )
  const guest = readFileSync(".github/scripts/paired-live-guest.mjs", "utf8")
  put(
    "guest.mjs",
    'import {createHash} from "node:crypto";\n' + guest.slice(guest.indexOf("const hash ="))
  )
  put(
    "stat",
    '#!/bin/sh\ncase "$2" in %u) echo 0;; %a) echo 600;; %u:%h) echo 0:1;; *)exit 19;; esac\n',
    0o700
  )
  put("flock", "#!/bin/sh\nexit 0\n", 0o700)
  put("timeout", '#!/bin/sh\nshift 2;exec "$@"\n', 0o700)
  put(
    "systemctl",
    `#!/bin/sh
echo "$*" >> "$FIX/units"
case "$1" in
 show) case "$*" in *ExecStart*) echo '{ path=/usr/local/libexec/lyrashield-run-worker ; argv[]=/usr/local/libexec/lyrashield-run-worker ; }';; *DropInPaths*) echo "\${DROPIN:-}";; esac ;;
 is-active) if [ "$LIVE" = 1 ];then echo active;else echo inactive;exit 3;fi ;;
 is-enabled) if [ "$LIVE" = 1 ];then echo enabled;else echo disabled;exit 1;fi ;;
 *) exit 90;;esac
`,
    0o700
  )
  put(
    "docker",
    `#!/usr/bin/env node
const fs=require("node:fs"),cp=require("node:child_process"),a=process.argv.slice(2),p=process.env
if(a[0]==="ps"){
 if(a.includes("-a")){if(p.LIVE==="1")console.log("lyrashield-worker")}
 else {if(p.LIVE==="1")console.log(p.WID);if(p.EXTRA)console.log(p.EXTRA)}
}else if(a[0]==="inspect"){
 const format=a.at(-1)
 if(format==="{{.Id}}")console.log(p.WID);else if(format==="{{.Image}}")console.log(p.WORKER_ID)
 else if(format==="{{.Config.Image}}")console.log(p.WORKER_REF)
 else if(format.includes("Healthcheck"))console.log(p.BAD_CMD?"wrong":'["CMD-SHELL","test -f /tmp/lyrashield-worker-ready"]')
 else if(format.includes("Entrypoint"))console.log("null [worker.js]");else if(format.includes("Health.Status"))console.log("healthy");else process.exit(41)
}else if(a[0]==="image"&&a[1]==="inspect"){
 const f=a.at(-1);if(f.includes("RepoDigests"))console.log(a[2]);else if(f.includes("Entrypoint"))console.log("null [worker.js]");else if(f.includes("revision"))console.log("d".repeat(40));else console.log(p.WORKER_ID)
}else if(a[0]==="exec"){const r=cp.spawnSync(a[2],a.slice(3),{stdio:"inherit",env:{...p,DATABASE_URL:p.RUNNING_DB,LYRASHIELD_IMAGE:p.SBOX,LYRASHIELD_WORKER_IMAGE_DIGEST:p.WORKER_REF.split("@")[1],LYRASHIELD_PRODUCT_REVISION:"d".repeat(40),LYRASHIELD_ENGINE_REVISION:"d".repeat(40),LYRASHIELD_RUN_RECORD_V1_1:"0",LYRASHIELD_PENDING_HTTP_EVIDENCE:"0",LYRASHIELD_EVIDENCE_WRITER_CANARY:p.RUNNING_SELECTOR||""}});process.exit(r.status)}
else if(a[0]==="run"){if(a.at(-2)==="rpc"){process.stdout.write("1");process.exit(0)}
 const v={};for(let i=0;i<a.length;i++){if(a[i]==="--env-file"){for(const line of fs.readFileSync(a[++i],"utf8").trim().split("\\n")){const n=line.indexOf("=");if(n>0)v[line.slice(0,n)]=line.slice(n+1)}}else if(a[i]==="--env"){const line=a[++i],n=line.indexOf("=");v[line.slice(0,n)]=line.slice(n+1)}}
 if(["unused","accounted","drain"].includes(a.at(-2))){if(!/^[a-f0-9]{64}$/.test(v.PAIRED_RUNTIME_DB_HASH))process.exit(8);process.stdout.write(a.at(-2)==="drain"?JSON.stringify("drained"):"true");process.exit(0)}
 const r=cp.spawnSync(process.execPath,[p.FIX+"/guest.mjs",a.at(-2),a.at(-1)],{stdio:"inherit",env:v});process.exit(r.status)
}else process.exit(42)
`,
    0o700
  )
  const start = (f = {}) => {
    put("cmdline", f.wrongProcess ? "sleep\0infinity\0" : "node\0tsx\0apps/worker/src/index.ts\0")
    put(
      "config",
      `LYRASHIELD_WORKER_IMAGE=${worker}\nLYRASHIELD_SANDBOX_IMAGE=${sandbox}\nLYRASHIELD_RUN_RECORD_V1_1=${f.run ?? 0}\nLYRASHIELD_PENDING_HTTP_EVIDENCE=${f.pending ?? 0}\nLYRASHIELD_SANDBOX_SBOM_COVERAGE_VERIFY_PATH=/tmp/coverage.json\nLYRASHIELD_SANDBOX_SBOM_COVERAGE_EXPECTED_PATH=/tmp/coverage-predicate.json\nLYRASHIELD_SANDBOX_SBOM_COVERAGE_REPO=ecryptoguru/lyrashield-engine\nLYRASHIELD_SANDBOX_SBOM_COVERAGE_REF=refs/heads/main\nLYRASHIELD_SANDBOX_SBOM_COVERAGE_ENGINE_REVISION=${"d".repeat(40)}\nLYRASHIELD_SANDBOX_SBOM_COVERAGE_WORKFLOW_REVISION=${"e".repeat(40)}\nLYRASHIELD_SANDBOX_SBOM_COVERAGE_RUN_ID=42487812345\nLYRASHIELD_SANDBOX_SBOM_COVERAGE_RUN_ATTEMPT=1\n`
    )
    rmSync(sibling, { force: true })
    if (f.disk !== undefined)
      put("config.evidence-writer-canary", "LYRASHIELD_EVIDENCE_WRITER_CANARY=" + f.disk + "\n")
    return spawnSync(
      "sh",
      [
        join(dir, "host.sh"),
        f.phase ?? "worker",
        Buffer.from('{"receipt":"test"}').toString("base64"),
        dir,
      ],
      {
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          PATH: dir + ":" + process.env.PATH,
          FIX: dir,
          WID: id,
          WORKER_ID: "sha256:" + "b".repeat(64),
          WORKER_REF: worker,
          SBOX: sandbox,
          LIVE: f.live ?? "1",
          RUNNING_DB: f.db ?? "private-fixture",
          SELECTOR_AWARE: f.aware ?? "0",
          RUNNING_SELECTOR: f.liveValue ?? "",
          DROPIN: f.dropin ?? "",
          BAD_CMD: f.badCmd ?? "",
          EXTRA: f.extra ?? "",
        },
      }
    )
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private fixture path
  return { start, units: () => readFileSync(join(dir, "units"), "utf8") }
}

test("next-start policy must equal the actual worker flags and exact sibling, without leaking it", (t) => {
  const { start } = setup(t)
  const valid = start()
  assert.equal(valid.status, 0, valid.stderr)
  assert.equal(JSON.parse(valid.stdout).canarySelectorPresent, false)
  const value = Buffer.from("private-canary-fixture").toString("base64url")
  for (const bad of [
    { run: 1, pending: 1 },
    { disk: value },
    { disk: value, aware: "1" },
    { disk: value, aware: "1", liveValue: value + "A" },
    { liveValue: value },
    { dropin: "unaccounted" },
  ]) {
    const r = start(bad)
    assert.notEqual(r.status, 0)
    assert.ok(!(r.stdout + r.stderr).includes(value))
  }
  const armed = start({ disk: value, aware: "1", liveValue: value })
  assert.equal(armed.status, 0, armed.stderr)
  assert.equal(JSON.parse(armed.stdout).canarySelectorPresent, true)
})
test("all running IDs are accounted for, even alias and image-ID consumers; containment never stops foreign services", (t) => {
  const { start, units } = setup(t)
  assert.equal(start({ phase: "stopped", live: "0" }).status, 0)
  for (const opts of [
    { extra: other },
    { phase: "stopped", live: "0", extra: other },
    { phase: "contain", extra: other },
    { phase: "stop", extra: other },
    { badCmd: "1" },
    { wrongProcess: true },
  ])
    assert.notEqual(start(opts).status, 0)
  assert.doesNotMatch(units(), /disable --now/)
})

test("each global operation rejects prospective service DB credentials that differ from the running worker", (t) => {
  const { start } = setup(t)
  for (const phase of ["drain", "unused", "accounted"]) {
    assert.notEqual(start({ phase, db: "different-live-authority" }).status, 0)
    const ok = start({ phase })
    assert.equal(ok.status, 0, ok.stderr)
  }
})
