import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import {
  baseline,
  parseSelection,
  prepareSelection,
  checkReaderSources,
  checkImageIdentity,
  readerPaths,
} from "../worker-evidence-drill-selection.mjs"

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
const candidateWorker = baseline.worker.replace(/:.{64}$/, ":" + "1".repeat(64))
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "drill-selection-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
test("only the default or one exact canonical candidate tuple is admitted", () => {
  assert.deepEqual(parseSelection([]), baseline)
  const p = "2".repeat(40),
    e = "3".repeat(40)
  assert.deepEqual(parseSelection(["--candidate", candidateWorker, p, e]), {
    worker: candidateWorker,
    product: p,
    engine: e,
  })
  for (const args of [
    ["--candidate", candidateWorker, p],
    ["--candidate", candidateWorker, p, e, "extra"],
    ["--candidate", candidateWorker.replace("ecryptoguru", "other"), p, e],
    ["--candidate", candidateWorker.replace("@sha256:", ":tag@sha256:"), p, e],
    ["--candidate", candidateWorker.slice(0, -1), p, e],
    ["--candidate", candidateWorker, "HEAD", e],
    ["--candidate", candidateWorker, p, "3".repeat(39)],
    ["--candidate", candidateWorker, p, e + "\n"],
  ])
    assert.throws(() => parseSelection(args))
})
test("the baseline is derived from immutable Git source and all 15 runtime files must match", (t) => {
  const dir = scratch(t)
  const m = prepareSelection(root, dir, baseline)
  assert.equal(Object.keys(m.sources).length, 15)
  assert.equal(m.fingerprint, "ae1407d6bf00803854f6b536c25d3234093275d6f370e04206b9312c22084564")
  assert.equal(
    readerPaths["@lyrashield/evidence-storage"],
    "packages/evidence-storage/src/index.ts"
  )
  const read = (name) =>
    execFileSync("git", ["-C", root, "show", baseline.product + ":" + readerPaths[name]])
  checkReaderSources(m, read)
  assert.throws(() =>
    checkReaderSources(m, (name) =>
      name === "src/queue-reconciliation.ts" ? Buffer.from("wrong image") : read(name)
    )
  )
  assert.throws(() =>
    checkReaderSources({ ...m, sources: { ...m.sources, extra: "0".repeat(64) } }, read)
  )
  assert.throws(() => checkReaderSources({ ...m, fingerprint: "0".repeat(64) }, read))
  assert.match(readFileSync(join(dir, "migrations.sql"), "utf8"), /CREATE TABLE/)
})
test("preloaded image must have the chosen repository digest and both exact revision labels", () => {
  checkImageIdentity(baseline, [baseline.worker], baseline.product, baseline.engine)
  for (const args of [
    [[candidateWorker], baseline.product, baseline.engine],
    [[baseline.worker], "other", baseline.engine],
    [[baseline.worker], baseline.product, "other"],
    [null, baseline.product, baseline.engine],
  ])
    assert.throws(() => checkImageIdentity(baseline, ...args))
})
test("selected candidate blobs and migrations are independent of a later clean checkout; dirty sources fail", (t) => {
  const repo = scratch(t)
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()
  git("init", "-q")
  git("config", "user.email", "fixture@example.invalid")
  git("config", "user.name", "fixture")
  function put(path, data) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), data)
  }
  for (const [name, path] of Object.entries(readerPaths)) put(path, "candidate " + name)
  const migration = "packages/db/prisma/migrations/20261103010000_fixture/migration.sql"
  put(migration, "SELECT 1;")
  git("add", ".")
  git("commit", "-qm", "candidate")
  const selection = {
    worker: candidateWorker,
    product: git("rev-parse", "HEAD"),
    engine: "3".repeat(40),
  }
  const changed = readerPaths["src/jobs/run-scan/pending-finalization.ts"]
  put(changed, "new checkout")
  put(migration, "SELECT 2;")
  git("add", ".")
  git("commit", "-qm", "later")
  const dir = scratch(t),
    manifest = prepareSelection(repo, dir, selection)
  checkReaderSources(manifest, (name) => Buffer.from("candidate " + name))
  assert.match(readFileSync(join(dir, "migrations.sql"), "utf8"), /SELECT 1;/)
  assert.doesNotMatch(readFileSync(join(dir, "migrations.sql"), "utf8"), /SELECT 2;/)
  assert.throws(() => prepareSelection(repo, scratch(t), { ...selection, product: "0".repeat(40) }))
  for (const path of [
    changed,
    migration,
    "packages/db/prisma/migrations/20261103020000_new/migration.sql",
  ]) {
    put(path, "dirty")
    assert.throws(() => prepareSelection(repo, scratch(t), selection), /dirty/i)
    git("reset", "--hard", "HEAD")
    git("clean", "-fd")
  }
})
