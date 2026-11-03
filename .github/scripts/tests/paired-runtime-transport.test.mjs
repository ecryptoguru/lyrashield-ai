import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync, execFileSync } from "node:child_process"
import { mkdtempSync, openSync, closeSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const worker = "sha256:" + "a".repeat(64),
  prior = "sha256:" + "b".repeat(64)
const owner = "111:2",
  engine = "c".repeat(40)
const goodLine = "Worker paired release promotion passed for " + worker + "; scan admission HELD"
const nonce = "a5".repeat(32),
  stale = "b6".repeat(32)
const prefix = "PAIRED_VM_COMPLETED " + owner + " " + worker
const completed = prefix + " " + nonce
const resultFile = ".github/scripts/paired-runtime-vm-result.mjs"
function result(message, code = "ComponentStatus/StdOut/succeeded", stderr = "", expected = nonce) {
  // The expected challenge uses a separate inherited descriptor, never argv/env.
  const dir = mkdtempSync(join(tmpdir(), "paired-receipt-"))
  const file = join(dir, "challenge")
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- private test scratch
    writeFileSync(file, expected)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- private test scratch
    const fd = openSync(file, "r")
    try {
      return spawnSync(process.execPath, [resultFile, owner, worker], {
        input: JSON.stringify({
          value: [
            { code, message },
            { code: "ComponentStatus/StdErr/succeeded", message: stderr },
          ],
        }),
        stdio: ["pipe", "pipe", "pipe", fd],
        encoding: "utf8",
      })
    } finally {
      closeSync(fd)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
test("VM requires held and terminal guest acknowledgement in successful stdout only", () => {
  assert.equal(result(goodLine + "\n" + completed).status, 0)
  assert.equal(
    result("Enable succeeded:\n[stdout]\n" + goodLine + "\n" + completed + "\n[stderr]\n").status,
    0
  )
  const progress = "Created symlink /etc/systemd/system/timers.target.wants/worker.timer"
  assert.equal(result(goodLine + "\n" + completed, undefined, progress).status, 0)
  assert.equal(
    result(
      "Enable succeeded:\n[stdout]\n" + goodLine + "\n" + completed + "\n[stderr]\n" + progress
    ).status,
    0
  )
  for (const [message, code] of [
    [goodLine + "\n" + prefix],
    [goodLine + "\n" + completed.replace(nonce, stale)],
    [goodLine + "\n" + prefix + "\n[stderr]\nguest shell exited 1"],
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

test("a failed guest diagnostic cannot authorize promotion or disclose the challenge", () => {
  const failure = result(
    goodLine + "\n" + prefix,
    undefined,
    "guest command exited unsuccessfully (exit 1)"
  )
  assert.notEqual(failure.status, 0)
  assert.ok(!failure.stderr.includes(nonce))
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
if(a[0]==="vm"){
  if(process.env.MOCK_VM_TIMEOUT==="1"){console.error("fixture-sensitive-transport-text");process.exit(124)}
  const shell=a[a.indexOf("--scripts")+1], ack=shell.match(/PAIRED_VM_COMPLETED [0-9:]+ sha256:[a-f0-9]{64} ([a-f0-9]{64})'/)
  if(!ack)process.exit(19)
  console.log(process.env.VM_RESPONSE.replace("MOCK_GUEST_CHALLENGE", ack[1]));process.exit(0)
}
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
  const args = [
    owner,
    sha,
    engine,
    worker,
    prior,
    "resource-group",
    "worker-vm",
    "fixture-vault",
    "sha256:" + "c".repeat(64),
  ]
  const pass = run("vm", args, {
    VM_RESPONSE: JSON.stringify({
      value: [
        {
          code: "ComponentStatus/StdOut/succeeded",
          message: goodLine + "\n" + prefix + " MOCK_GUEST_CHALLENGE",
        },
      ],
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
  const challenge = command.match(
    /PAIRED_VM_COMPLETED [0-9:]+ sha256:[a-f0-9]{64} ([a-f0-9]{64})'/
  )[1]
  assert.equal(command.split(challenge).length, 3)
  assert.ok(!pass.stdout.includes(challenge) && !pass.stderr.includes(challenge))
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

test("guest shell generates its private acknowledgement only after a genuine successful exit", (t) => {
  const { run, calls } = commands(t),
    sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  const args = [
    owner,
    sha,
    engine,
    worker,
    prior,
    "resource-group",
    "worker-vm",
    "fixture-vault",
    "sha256:" + "c".repeat(64),
  ]
  const response = {
    VM_RESPONSE: JSON.stringify({
      value: [
        {
          code: "ComponentStatus/StdOut/succeeded",
          message: goodLine + "\n" + prefix + " MOCK_GUEST_CHALLENGE",
        },
      ],
    }),
  }
  const payload = (path) =>
    execFileSync("git", ["--no-replace-objects", "show", sha + ":" + path]).toString("base64")
  const host = payload(".github/scripts/promote-worker-vm.sh"),
    drain = payload(".github/scripts/v26-execution-drain.sh")
  const challenges = []
  for (const success of [true, false]) {
    const invocation = run("vm", args, response)
    assert.equal(invocation.status, 0)
    const call = calls().at(-1),
      command = call[call.indexOf("--scripts") + 1]
    const challenge = command.match(
      /PAIRED_VM_COMPLETED [0-9:]+ sha256:[a-f0-9]{64} ([a-f0-9]{64})'/
    )[1]
    challenges.push(challenge)
    // Substitute EXACT Git blobs before executing the unchanged supervising sh.
    // Both mock programs run locally without any service, provider or cloud tool.
    assert.equal(command.split(host).length, 2)
    assert.equal(command.split(drain).length, 2)
    const promoter = [
      "set -eu",
      '[ "$#" = 6 ]',
      '[ -z "${completion_nonce+x}" ]',
      '[ "$1" = --paired-release-stopped ]',
      'echo "Created symlink for worker timer" >&2',
      'printf "%s\\n" "' + goodLine + '"',
      ...(success ? [] : ['printf "%s\\n" "' + prefix + '"', "exit 1"]),
    ].join("\n")
    const shim = (source) => Buffer.from(source).toString("base64")
    const guest = spawnSync(
      "sh",
      [
        "-c",
        command
          .replace(host, shim(promoter))
          .replace(drain, shim("echo V26_EXECUTION_DRAIN_VERIFIED")),
      ],
      { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5000 }
    )
    assert.equal(guest.status, success ? 0 : 1)
    assert.equal(guest.stdout.includes(challenge), success)
    assert.ok(guest.stderr.includes("Created symlink"))
    const receipt = result(guest.stdout, undefined, guest.stderr, challenge)
    assert.equal(receipt.status === 0, success)
    if (!success) assert.match(receipt.stderr, /guest stage promote, exit 1/)
    assert.ok(!receipt.stdout.includes(challenge) && !receipt.stderr.includes(challenge))
  }
  assert.notEqual(challenges[0], challenges[1])
})

test("ambiguous transport timeout exposes only bounded recovery metadata", (t) => {
  const { run } = commands(t),
    sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  const r = run(
    "vm",
    [
      owner,
      sha,
      engine,
      worker,
      prior,
      "resource-group",
      "worker-vm",
      "fixture-vault",
      "sha256:" + "c".repeat(64),
    ],
    { MOCK_VM_TIMEOUT: "1" }
  )
  assert.equal(r.status, 124)
  assert.match(r.stderr, /Paired VM transport: timeout/)
  assert.match(r.stderr, /Paired VM transport exit 124; guest status unknown/)
  assert.ok(!r.stderr.includes("fixture-sensitive") && !r.stdout.includes("fixture-sensitive"))
})
