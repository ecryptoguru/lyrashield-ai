import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import * as filesystem from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  classifyColdContainers,
  executeColdBarrier,
  executeDurableColdBarrier,
} from "../../../ops/worker/cold-start-barrier.mjs"
const options = {
  workerImage: `ghcr.io/ecryptoguru/lyrashield-worker@sha256:${"a".repeat(64)}`,
  sandboxImage: `ghcr.io/ecryptoguru/lyrashield-sandbox@sha256:${"b".repeat(64)}`,
  network: "lyrashield-sandbox",
}
const sandbox = () => ({
  Id: "c".repeat(64),
  Image: `sha256:${"b".repeat(64)}`,
  Name: "/old-sandbox",
  Config: { Image: options.sandboxImage, Labels: { "strix-run-id": "c1234567890123456789012345" } },
  HostConfig: { NetworkMode: options.network, RestartPolicy: { Name: "no" } },
  Mounts: [{ Type: "bind", Source: "/var/lib/lyrashield/worker/tmp/strix_repos/old" }],
  State: { Running: true, Pid: 20 },
})
function fixture({ fail = "", delayed = false } = {}) {
  let resources = delayed ? [] : [sandbox()]
  const calls = []
  const command = (program, args) => {
    const call = `${program} ${args.join(" ")}`
    calls.push(call)
    if (fail && call.includes(fail)) throw new Error("lost native acknowledgement")
    if (program === "docker" && args[0] === "image")
      return `sha256:${args[2] === options.workerImage ? "a".repeat(64) : "b".repeat(64)}`
    if (args[0] === "show") return args.includes("--property=MainPID") ? "0\n" : "inactive\n"
    if (program === "docker" && args[1] === "ls") return resources.map((r) => r.Id).join("\n")
    if (program === "docker" && args[1] === "inspect") return JSON.stringify(resources)
    if (program === "docker" && args[1] === "rm")
      resources = resources.filter((r) => r.Id !== args.at(-1))
    if (call === "systemctl start docker.service" && delayed) resources = [sandbox()]
    return ""
  }
  return { calls, command }
}
test("cold restart terminates only authenticated old native sandbox after daemon barrier", () => {
  const f = fixture()
  assert.deepEqual(executeColdBarrier(options, f.command), {
    oldResources: 1,
    removedResources: 1,
    removedIds: ["c".repeat(64)],
  })
  assert.ok(
    f.calls.indexOf("systemctl stop docker.socket docker.service") <
      f.calls.findIndex((c) => c.startsWith("docker container rm"))
  )
  assert.ok(f.calls.includes(`docker container rm --force ${"c".repeat(64)}`))
})
test("an accepted delayed create is authenticated and terminated after daemon restart", () => {
  const f = fixture({ delayed: true })
  assert.deepEqual(executeColdBarrier(options, f.command), {
    oldResources: 0,
    removedResources: 1,
    removedIds: ["c".repeat(64)],
  })
})
for (const fail of [
  "systemctl stop lyrashield-worker",
  "flock --nonblock",
  "systemctl stop docker.socket",
  "systemctl start docker.service",
  "docker container rm",
]) {
  test(`lost acknowledgement at ${fail} fails closed`, () => {
    const f = fixture({ fail })
    assert.throws(() => executeColdBarrier(options, f.command), /lost native acknowledgement/)
  })
}
test("foreign images, labels, network, bind mounts and restart policies are rejected", () => {
  for (const mutate of [
    (r) => {
      r.Config.Image = "foreign"
    },
    (r) => {
      r.Config.Labels["strix-run-id"] = "../foreign"
    },
    (r) => {
      r.HostConfig.NetworkMode = "bridge"
    },
    (r) => {
      r.Mounts[0].Source = "/foreign"
    },
    (r) => {
      r.HostConfig.RestartPolicy.Name = "always"
    },
  ]) {
    const r = sandbox()
    mutate(r)
    assert.throws(() => classifyColdContainers([r], options), /unresolved|unauthenticated/)
  }
})
test("launcher checks persistent fence before any consumer or registry operation", () => {
  const source = readFileSync("ops/worker/run-worker.sh", "utf8")
  assert.ok(
    source.indexOf('"$cold_start_directory/pending"') < source.indexOf("login_to_registry()")
  )
  assert.match(source, /flock -n 9/)
  assert.ok(
    source.indexOf(': > "$cold_start_directory/owner-started"') < source.indexOf("docker create \\")
  )
  assert.match(source, /\[ -e "\$cold_start_directory\/owner-started" \]/)
  assert.doesNotMatch(source, /docker rm -f lyrashield-worker.*true/)
  const worker = readFileSync("apps/worker/src/index.ts", "utf8")
  assert.ok(
    worker.indexOf("await assertNoNativeScanResources()") < worker.indexOf("worker = new Worker")
  )
})

function durabilityFixture(failSync = 0) {
  const events = []
  let syncs = 0
  const io = {
    openSync(path) {
      events.push(`open:${path}`)
      return path
    },
    closeSync(fd) {
      events.push(`close:${fd}`)
    },
    fsyncSync(fd) {
      events.push(`sync:${fd}`)
      if (++syncs === failSync) throw new Error("durability acknowledgement lost")
    },
    writeFileSync(fd) {
      events.push(`write:${fd}`)
    },
    renameSync(from, to) {
      events.push(`rename:${to}`)
    },
    unlinkSync(path) {
      events.push(`unlink:${path}`)
    },
    readFileSync() {
      return "boot-id\n"
    },
  }
  const f = fixture()
  const command = (program, args) => {
    events.push(`command:${program} ${args.join(" ")}`)
    return f.command(program, args)
  }
  return { events, io, command }
}

test("durable pending precedes native effects, durable receipt precedes fence removal", () => {
  const f = durabilityFixture()
  executeDurableColdBarrier(options, f.command, f.io)
  const nativeStop = f.events.findIndex(
    (e) => e === "command:systemctl stop lyrashield-worker.service"
  )
  const pendingSync = f.events.findIndex((e) => e.endsWith("/pending") && e.startsWith("sync:"))
  const parentSync = f.events.indexOf("sync:/var/lib/lyrashield")
  const rename = f.events.indexOf("rename:/var/lib/lyrashield/worker-cold-start/receipt.json")
  const receiptSync = f.events.findIndex((e) => e.startsWith("sync:") && e.includes("/receipt-"))
  const durableReceiptDirectory = f.events.indexOf(
    "sync:/var/lib/lyrashield/worker-cold-start",
    rename
  )
  const firstUnlink = f.events.findIndex((e) => e.startsWith("unlink:"))
  assert.ok(pendingSync < parentSync && parentSync < nativeStop)
  assert.ok(
    receiptSync < rename &&
      rename < durableReceiptDirectory &&
      durableReceiptDirectory < firstUnlink
  )
  assert.equal(f.events.at(-2), "sync:/var/lib/lyrashield/worker-cold-start")
})

for (const failSync of [1, 2, 3, 4, 5, 6]) {
  test(`durability failure at sync ${failSync} never returns a success receipt`, () => {
    const f = durabilityFixture(failSync)
    assert.throws(
      () => executeDurableColdBarrier(options, f.command, f.io),
      /durability acknowledgement lost/
    )
    if (failSync <= 3) assert.ok(!f.events.some((e) => e.startsWith("command:")))
    if (failSync <= 5) assert.ok(!f.events.some((e) => e.startsWith("unlink:")))
    if (failSync === 6)
      assert.equal(
        f.events.filter((e) => e === "open:/var/lib/lyrashield/worker-cold-start/pending").length,
        2
      )
  })
}

function realDurabilityFixture(t) {
  const parent = filesystem.mkdtempSync(join(tmpdir(), "cold-durability-"))
  const state = join(parent, "state")
  filesystem.mkdirSync(state, { mode: 0o700 })
  t.after(() => filesystem.rmSync(parent, { recursive: true, force: true }))
  const path = (value) =>
    value
      .replace("/var/lib/lyrashield/worker-cold-start", state)
      .replace("/var/lib/lyrashield", parent)
  const io = {
    ...filesystem,
    openSync: (value, ...args) => filesystem.openSync(path(value), ...args),
    renameSync: (from, to) => filesystem.renameSync(path(from), path(to)),
    unlinkSync: (value) => filesystem.unlinkSync(path(value)),
    readFileSync: () => "boot-id\n",
  }
  return { state, io }
}

test("real file/directory fsync publishes receipt before removing startup fences", (t) => {
  const f = realDurabilityFixture(t)
  filesystem.writeFileSync(join(f.state, "owner-started"), "", { mode: 0o600 })
  executeDurableColdBarrier(options, fixture().command, f.io)
  assert.equal(filesystem.existsSync(join(f.state, "pending")), false)
  assert.equal(filesystem.existsSync(join(f.state, "owner-started")), false)
  assert.equal(filesystem.statSync(join(f.state, "receipt.json")).mode & 0o777, 0o600)
  assert.equal(
    JSON.parse(filesystem.readFileSync(join(f.state, "receipt.json"), "utf8")).bootId,
    "boot-id"
  )
})

test("native acknowledgement failure retains actual durable pending marker", (t) => {
  const f = realDurabilityFixture(t)
  assert.throws(
    () => executeDurableColdBarrier(options, fixture({ fail: "systemctl stop" }).command, f.io),
    /lost native acknowledgement/
  )
  assert.equal(filesystem.statSync(join(f.state, "pending")).mode & 0o777, 0o600)
  assert.equal(filesystem.existsSync(join(f.state, "receipt.json")), false)
})
