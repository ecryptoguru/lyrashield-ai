// Host-only preflight ordering. This executable simulates the Docker CLI; no daemon is used.
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { baseline, readerPaths } from "../worker-evidence-drill-selection.mjs"

const root = fileURLToPath(new URL("../../../", import.meta.url))
const script = join(root, ".github/scripts/run-worker-evidence-persistence-drill.sh")
const fixtures = process.env.LYRA_DRILL_WRITER_FIXTURES

function mockCli(t) {
  const path = mkdtempSync(join(tmpdir(), "drill-launcher-"))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  const cli = join(path, "docker")
  writeFileSync(
    cli,
    `#!/usr/bin/env node
const {appendFileSync,copyFileSync}=require("node:fs"),{spawnSync}=require("node:child_process"),{join}=require("node:path")
const a=process.argv.slice(2),{ MOCK_DIR:dir,MOCK_WORKER:worker,MOCK_PRODUCT:product,MOCK_ENGINE:engine,MOCK_MODE:mode }=process.env
function fail(msg){process.stderr.write(msg+"\\n");process.exit(79)}
const name=a[a.indexOf("--name")+1]||""
const op=a[0]==="run"?(name.endsWith("-reader")?"reader":name.endsWith("-space")?"space":"service"):a.slice(0,2).join(" ")
appendFileSync(join(dir,"events"),op+"\\n")
if(a[0]==="image"&&a[1]==="inspect"){
 if(a.includes("--format")){
  if(a.at(-1)!==worker||!a[a.indexOf("--format")+1].includes(".RepoDigests"))fail("bad image inspect")
  console.log(JSON.stringify(mode==="bad-digest"?[]:[worker]))
  console.log(JSON.stringify(mode==="bad-label"?"bad":product))
  console.log(JSON.stringify(engine))
 }
} else if(op==="reader"){
 if(mode==="silent-verifier")process.exit(0)
 for(const arg of ["--rm","never","none","ALL","no-new-privileges","--read-only",worker])if(!a.includes(arg))fail("unfenced preflight")
 if(a.includes("--env")||a.includes("--volume")||a.includes("-v"))fail("unexpected reader input")
 const mounts=a.filter((_,i)=>i&&a[i-1]==="--mount")
 if(mounts.length!==2||!mounts.every(m=>m.endsWith(",readonly")))fail("unexpected reader mounts")
 const sourceFor=dest=>mounts.find(m=>m.includes(",dst="+dest+",")).split(",src=")[1].split(",dst=")[0]
 const name="worker-evidence-drill-selection.mjs"
 copyFileSync(sourceFor("/app/apps/worker/"+name),join(dir,name))
 const r=spawnSync(process.execPath,[join(dir,name),"reader",sourceFor("/reader-selection.json")],{cwd:dir,stdio:"inherit"})
 process.exit(r.status??78)
} else if(op==="space")fail("host probe complete before services")
else if(op!=="ps -aq"&&op!=="network ls")fail("unexpected Docker operation: "+op)
`
  )
  chmodSync(cli, 0o755)
  return path
}

function launch(dir, selection, mode, args) {
  writeFileSync(join(dir, "events"), "")
  const result = spawnSync("bash", [script, "--fixtures", fixtures || "/unused", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      PATH: dir + ":" + process.env.PATH,
      MOCK_DIR: dir,
      MOCK_MODE: mode,
      MOCK_WORKER: selection.worker,
      MOCK_PRODUCT: selection.product,
      MOCK_ENGINE: selection.engine,
    },
  })
  assert.ok(!result.error, String(result.error))
  return {
    ...result,
    events: readFileSync(join(dir, "events"), "utf8").trim().split("\n").filter(Boolean),
  }
}

test("invalid candidate or nonexistent Git revision never invokes Docker", (t) => {
  const dir = mockCli(t)
  for (const [worker, product] of [
    [baseline.worker + ":tag", baseline.product],
    [baseline.worker, "0".repeat(40)],
  ]) {
    const r = launch(dir, baseline, "host", ["--candidate", worker, product, baseline.engine])
    assert.notEqual(r.status, 0)
    assert.deepEqual(r.events, [])
  }
})

test(
  "supervised candidate checks preloaded labels and actual reader bytes before services",
  { skip: !fixtures },
  (t) => {
    const dir = mockCli(t)
    const product = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim()
    const pair = {
      worker: baseline.worker.replace(/:[0-9a-f]{64}$/, ":" + "7".repeat(64)),
      product,
      engine: "8".repeat(40),
    }
    const tuple = ["--candidate", pair.worker, pair.product, pair.engine]
    for (const [name, path] of Object.entries(readerPaths)) {
      const location = name.startsWith("@")
        ? join(dir, "node_modules", name, "src/index.ts")
        : join(dir, name)
      mkdirSync(dirname(location), { recursive: true })
      writeFileSync(location, execFileSync("git", ["-C", root, "show", product + ":" + path]))
      if (name.startsWith("@"))
        writeFileSync(
          join(dirname(dirname(location)), "package.json"),
          JSON.stringify({ name, main: "./src/index.ts" })
        )
    }
    for (const mode of ["bad-label", "bad-digest"]) {
      const r = launch(dir, pair, mode, tuple)
      assert.notEqual(r.status, 0)
      assert.ok(r.events.length > 0 && r.events.every((op) => op === "image inspect"), r.stderr)
    }
    const silent = launch(dir, pair, "silent-verifier", tuple)
    assert.notEqual(silent.status, 0)
    assert.ok(
      silent.events.includes("reader") &&
        !silent.events.includes("space") &&
        !silent.events.includes("service")
    )
    const positive = launch(dir, pair, "valid", tuple)
    assert.notEqual(positive.status, 0)
    assert.ok(positive.events.includes("space"), positive.stderr)
    assert.ok(!positive.events.includes("service"))
    const identity = JSON.parse(positive.stdout.split("\n").find((line) => line.startsWith("{")))
    assert.equal(identity.source, product)
    assert.equal(identity.engineRevision, pair.engine)
    assert.equal(identity.workerImage, pair.worker)
    assert.equal(identity.readerSources, 15)
    writeFileSync(join(dir, "src/jobs/run-scan/pending-finalization.ts"), "incorrect reader bytes")
    const r = launch(dir, pair, "bad-reader", tuple)
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /image reader bytes differ/)
    assert.ok(r.events.includes("reader"))
    assert.ok(!r.events.includes("space") && !r.events.includes("service"))
  }
)
