// Only the host builds a manifest. The isolated preflight and each worker phase read it.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, existsSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repository = "ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@sha256:"
export const baseline = Object.freeze({
  worker: repository + "0c91d2a9dd91cfaa9a35ed9742aa118015a5deba8af324c1996d95d050442d5d",
  product: "ed84ce06889e6a9c047db220fcabfa0c643200ad",
  engine: "3001517530300ca5f602536bfadcbd3c95ad3039",
})
const baselineFingerprint = "ae1407d6bf00803854f6b536c25d3234093275d6f370e04206b9312c22084564"
const runtimeNames = [
  "src/engine/output-parser.ts",
  "src/engine/output-parser-evidence.ts",
  "src/engine/output-parser-artifacts.ts",
  "src/engine/output-parser-findings.ts",
  "src/engine/output-parser-run.ts",
  "src/engine/normalizer.ts",
  "src/engine/finding-persister.ts",
  "src/engine/evidence-storage.ts",
  "src/engine/result-integrity/detection-receipt.ts",
  "src/engine/result-integrity/result-manifest.ts",
  "src/jobs/run-scan/finalization.ts",
  "src/jobs/run-scan/pending-finalization.ts",
  "src/jobs/run-scan/http-exchange-evidence.ts",
  "src/queue-reconciliation.ts",
  "@lyrashield/evidence-storage",
]
export const readerPaths = Object.freeze(
  Object.fromEntries(
    runtimeNames.map((name) => [
      name,
      name.startsWith("@") ? "packages/evidence-storage/src/index.ts" : "apps/worker/" + name,
    ])
  )
)
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const hex = (value, length) =>
  typeof value === "string" && value.length === length && /^[0-9a-f]+$/.test(value)

function checkSelection({ worker, product, engine }) {
  assert.ok(
    typeof worker === "string" &&
      worker.startsWith(repository) &&
      hex(worker.slice(repository.length), 64),
    "invalid canonical worker digest"
  )
  assert.ok(hex(product, 40) && hex(engine, 40), "expected full product and engine commit SHAs")
  return { worker, product, engine }
}

export function parseSelection(args) {
  if (!args.length) return baseline
  assert.ok(
    args.length === 4 && args[0] === "--candidate",
    "expected --candidate WORKER@sha256:DIGEST PRODUCT_SHA ENGINE_SHA"
  )
  return checkSelection({ worker: args[1], product: args[2], engine: args[3] })
}

function fingerprint(sources) {
  return hash(runtimeNames.map((name) => name + "\0" + sources[name] + "\n").join(""))
}

function checkManifest(manifest) {
  checkSelection(manifest)
  assert.equal(manifest.version, 1, "unknown drill selection manifest version")
  assert.deepEqual(
    Object.keys(manifest.sources).sort(),
    [...runtimeNames].sort(),
    "reader path set changed"
  )
  for (const digest of Object.values(manifest.sources))
    assert.ok(hex(digest, 64), "invalid reader source hash")
  assert.equal(manifest.fingerprint, fingerprint(manifest.sources), "invalid reader fingerprint")
  if (manifest.product === baseline.product)
    assert.equal(manifest.fingerprint, baselineFingerprint, "baseline reader fingerprint changed")
  return manifest
}

export function prepareSelection(root, scratch, selection) {
  const { worker, product, engine } = checkSelection(selection)
  const git = (...args) =>
    execFileSync("git", ["--no-replace-objects", "-C", root, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    })
  assert.equal(
    git("rev-parse", "--verify", product + "^{commit}")
      .toString()
      .trim(),
    product,
    "selected product is not a commit"
  )
  const migrations = "packages/db/prisma/migrations"
  const selectedPaths = [...Object.values(readerPaths), migrations]
  assert.equal(
    git("status", "--porcelain=v1", "--untracked-files=all", "--", ...selectedPaths).length,
    0,
    "dirty reader or migration sources"
  )
  const tree = new Map()
  for (const row of git("ls-tree", "-rz", product, "--", ...selectedPaths)
    .toString()
    .split("\0")
    .filter(Boolean)) {
    const match = /^100644 blob ([a-f0-9]{40})\t([^\n\r\t]+)$/.exec(row)
    assert.ok(match, "expected regular selected Git blob")
    tree.set(match[2], match[1])
  }
  function blob(path) {
    assert.ok(tree.has(path), "missing selected Git blob: " + path)
    return git("cat-file", "blob", tree.get(path))
  }
  const sources = Object.fromEntries(
    Object.entries(readerPaths).map(([name, path]) => [name, hash(blob(path))])
  )
  const manifest = checkManifest({
    version: 1,
    worker,
    product,
    engine,
    sources,
    fingerprint: fingerprint(sources),
  })
  const sql = Array.from(tree.keys())
    .filter(
      (path) => path.startsWith(migrations + "/") && path !== migrations + "/migration_lock.toml"
    )
    .sort()
  assert.ok(sql.length, "selected migration tree is empty")
  const fd = openSync(join(scratch, "migrations.sql"), "wx", 0o600)
  try {
    for (const path of sql) {
      assert.match(path, /^packages\/db\/prisma\/migrations\/[0-9][a-zA-Z0-9_-]+\/migration\.sql$/)
      writeFileSync(fd, blob(path))
      writeFileSync(fd, "\n")
    }
  } finally {
    closeSync(fd)
  }
  writeFileSync(join(scratch, "reader-selection.json"), JSON.stringify(manifest) + "\n", {
    flag: "wx",
    mode: 0o444,
  })
  return manifest
}

export function checkImageIdentity(selection, digests, productLabel, engineLabel) {
  checkSelection(selection)
  assert.ok(
    Array.isArray(digests) && digests.includes(selection.worker),
    "preloaded canonical repository digest mismatch"
  )
  assert.equal(productLabel, selection.product, "preloaded worker product revision mismatch")
  assert.equal(engineLabel, selection.engine, "preloaded worker engine revision mismatch")
}

export function readManifest(path) {
  return checkManifest(JSON.parse(readFileSync(path, "utf8")))
}

export function checkReaderSources(
  manifest,
  read = (name) =>
    readFileSync(name.startsWith("@") ? fileURLToPath(import.meta.resolve(name)) : resolve(name))
) {
  checkManifest(manifest)
  const actual = {}
  for (const name of runtimeNames) {
    actual[name] = hash(read(name))
    assert.equal(actual[name], manifest.sources[name], "image reader bytes differ: " + name)
  }
  const result = fingerprint(actual)
  assert.equal(result, manifest.fingerprint, "image reader fingerprint mismatch")
  return result
}

export function proofIdentity(manifest) {
  return {
    selectionVersion: manifest.version,
    source: manifest.product,
    engineRevision: manifest.engine,
    workerImage: manifest.worker,
    readerFingerprint: manifest.fingerprint,
    readerSources: runtimeNames.length,
  }
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [command, ...args] = process.argv.slice(2)
  if (command === "validate") parseSelection(args)
  else if (command === "prepare") {
    const [root, scratch, ...tuple] = args
    const manifest = prepareSelection(root, scratch, parseSelection(tuple))
    console.log(manifest.worker, manifest.product, manifest.engine)
  } else if (command === "image" && args.length === 1) {
    const lines = readFileSync(0, "utf8").trimEnd().split("\n")
    assert.equal(lines.length, 3, "unexpected preloaded image metadata")
    checkImageIdentity(readManifest(args[0]), ...lines.map((line) => JSON.parse(line)))
  } else if (command === "receipt" && args.length === 1) {
    const expected = { phase: "image-reader-preflight", ...proofIdentity(readManifest(args[0])) }
    assert.deepEqual(
      JSON.parse(readFileSync(0, "utf8")),
      expected,
      "image reader preflight did not produce its exact receipt"
    )
    console.log(JSON.stringify(expected))
  } else if (command === "reader" && args.length === 1) {
    const manifest = readManifest(args[0])
    checkReaderSources(manifest)
    console.log(JSON.stringify({ phase: "image-reader-preflight", ...proofIdentity(manifest) }))
  } else throw new Error("unknown drill selection command")
}
