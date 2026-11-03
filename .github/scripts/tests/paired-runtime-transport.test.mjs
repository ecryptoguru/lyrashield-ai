import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync, execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const worker = "sha256:" + "a".repeat(64),
  prior = "sha256:" + "b".repeat(64)
const owner = "111:2",
  engine = "c".repeat(40)
const goodLine = "Worker paired release promotion passed for " + worker + "; scan admission HELD"
const completed = "PAIRED_VM_COMPLETED " + owner + " " + worker
const resultFile = ".github/scripts/paired-runtime-vm-result.mjs"
function result(message, code = "ComponentStatus/StdOut/succeeded") {
  return spawnSync(process.execPath, [resultFile, owner, worker], {
    input: JSON.stringify({ value: [{ code, message }] }),
    encoding: "utf8",
  })
}
test("VM requires held and terminal guest acknowledgement in successful stdout only", () => {
  assert.equal(result(goodLine + "\n" + completed).status, 0)
  assert.equal(
    result("Enable succeeded:\n[stdout]\n" + goodLine + "\n" + completed + "\n[stderr]\n").status,
    0
  )
  for (const [message, code] of [
    [goodLine],
    [completed],
    [goodLine + "\n" + completed + "\nother"],
    ["[stderr]\n" + goodLine + "\n" + completed],
    [goodLine + "\n" + completed, "ComponentStatus/StdOut/failed"],
    [goodLine + "\n" + completed, "ComponentStatus/StdErr/succeeded"],
    ["Worker promotion passed for " + worker + "\n" + completed],
    [goodLine + "\n" + completed.replace(owner, "111:3")],
  ])
    assert.notEqual(result(message, code).status, 0)
})

function commands(t) {
  const dir = mkdtempSync(join(tmpdir(), "paired-commands-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const log = join(dir, "calls")
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- only this test’s private temporary fixture
  writeFileSync(log, "")
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- only this test’s private temporary fixture
  writeFileSync(
    join(dir, "timeout"),
    '#!/bin/sh\n[ "$1" = --kill-after=10s ] && [ "$2" = 1800s ] || exit 21\nshift 2\nexec "$@"\n',
    { mode: 0o700 }
  )
  // Command recorder only. No Azure CLI call or submitted RunCommand.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- only this test’s private temporary fixture
  writeFileSync(
    join(dir, "az"),
    `#!/usr/bin/env node
const fs=require("node:fs"), a=process.argv.slice(2)
fs.appendFileSync(process.env.RECORD,JSON.stringify(a)+"\\n")
const args=a.slice(0,4).join(" "), name=a[a.indexOf("--name")+1]
if(a[0]==="vm"){console.log(process.env.VM_RESPONSE);process.exit(0)}
if(args.startsWith("containerapp revision show")){
 const image="ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-egress-proxy@"+process.env.DIGEST
 console.log(JSON.stringify({name:name+"--new",properties:{active:true,healthState:"Healthy",template:{containers:[{image:process.env.BAD_IMAGE||image}]}}}))
}else if(args==="containerapp ingress traffic show") console.log(process.env.TRAFFIC)
else if(args!=="containerapp ingress traffic set") process.exit(17)
`,
    { mode: 0o700 }
  )
  const run = (name, args, env = {}) =>
    spawnSync("bash", [".github/scripts/paired-runtime-" + name + ".sh", ...args], {
      env: {
        ...process.env,
        PATH: dir + ":" + process.env.PATH,
        RECORD: log,
        DIGEST: worker,
        ...env,
      },
      encoding: "utf8",
      timeout: 15000,
    })
  const calls = () =>
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- only this test’s private temporary fixture
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((x) => JSON.parse(x))
  return { run, calls }
}

test("relay adapter routes exact source digest and named revision then positively re-reads", (t) => {
  const { run, calls } = commands(t)
  const args = ["relay", "resource-group", "proxy", "proxy--new", worker]
  const pass = run("route", args, {
    TRAFFIC: JSON.stringify([{ revisionName: "proxy--new", weight: 100 }]),
  })
  assert.equal(pass.status, 0, pass.stderr)
  assert.deepEqual(
    calls().map((a) => a.slice(0, 4).join(" ")),
    [
      "containerapp revision show --name",
      "containerapp ingress traffic set",
      "containerapp ingress traffic show",
      "containerapp revision show --name",
    ]
  )
  for (const bad of [
    [{ revisionName: "proxy--new", weight: 100, label: "direct" }],
    [{ latestRevision: true, weight: 100 }],
    [
      { revisionName: "proxy--new", weight: 90 },
      { revisionName: "proxy--old", weight: 10 },
    ],
  ]) {
    assert.notEqual(run("route", args, { TRAFFIC: JSON.stringify(bad) }).status, 0)
  }
  const count = calls().length
  assert.notEqual(run("route", args, { BAD_IMAGE: "legacy:tag" }).status, 0)
  assert.equal(calls().length, count + 1)
  assert.notEqual(
    run("route", ["relay", "resource-group", "proxy", "other--new", worker]).status,
    0
  )
  assert.equal(calls().length, count + 1)
})

test("VM wrapper serializes fixed Git blobs, canonical worker refs and stopped-only mode", (t) => {
  const { run, calls } = commands(t)
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  const args = [owner, sha, engine, worker, prior, "resource-group", "worker-vm", "fixture-vault"]
  const pass = run("vm", args, {
    VM_RESPONSE: JSON.stringify({
      value: [{ code: "ComponentStatus/StdOut/succeeded", message: goodLine + "\n" + completed }],
    }),
  })
  assert.equal(pass.status, 0, pass.stderr)
  assert.equal(calls().length, 1)
  const [a] = calls()
  assert.deepEqual(a.slice(0, 3), ["vm", "run-command", "invoke"])
  const command = a[a.indexOf("--scripts") + 1]
  assert.match(
    command,
    /--paired-release-stopped 'ghcr\.io\/ecryptoguru\/lyrashield-ai\/lyrashield-worker@sha256:/
  )
  assert.ok(command.includes("V26_EXECUTION_DRAIN_VERIFIED"))
  assert.ok(command.includes("PAIRED_VM_COMPLETED"))
  assert.ok(!command.includes("--webhook-cutover") && !command.includes("--v26-cutover"))
  for (const [i, v] of [
    [0, "prior-owner"],
    [1, "0".repeat(40)],
    [3, "latest"],
    [7, "unsafe'"],
  ]) {
    assert.notEqual(run("vm", args.with(i, v)).status, 0)
  }
  assert.equal(calls().length, 1)
})
