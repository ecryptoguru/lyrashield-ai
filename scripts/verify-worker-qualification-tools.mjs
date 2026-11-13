#!/usr/bin/env node
/* eslint-disable security/detect-non-literal-fs-filename -- All mutations are confined to disposable local qualification fixtures. */
// Focused tool regressions use disposable copies of real writer fixtures and a
// tiny local Git repository. No dependency installs or contract suites run here.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  cpSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { after, test } from "node:test"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
assert(process.argv[2], "Pass the generated 13-bundle writer fixture directory")
const sourceFixtures = resolve(process.argv[2])
const workspace = mkdtempSync(join(tmpdir(), "lyrashield-qualification-tools-"))
after(() => rmSync(workspace, { recursive: true, force: true }))

function materializeRegularTree(source, destination) {
  const entry = lstatSync(source)
  assert(!entry.isSymbolicLink(), "Fixture symbolic links are not allowed")
  if (entry.isDirectory()) {
    mkdirSync(destination, { mode: 0o700 })
    for (const name of readdirSync(source)) {
      materializeRegularTree(join(source, name), join(destination, name))
    }
  } else {
    assert(entry.isFile(), "Fixtures must contain only regular files and directories")
    // Never preserve a source link or write through an existing destination.
    // Even if source metadata changes during reading, writes stay in private
    // directories as new regular files containing only copied bytes.
    writeFileSync(destination, readFileSync(source), { flag: "wx", mode: 0o600 })
  }
}

// Validate and materialize the entire input before registering mutation tests.
const fixtures = join(workspace, "source-fixtures")
try {
  materializeRegularTree(sourceFixtures, fixtures)
} catch (error) {
  rmSync(workspace, { recursive: true, force: true })
  throw error
}
let sequence = 0

function copyFixtures() {
  const root = join(workspace, `fixtures-${sequence++}`)
  materializeRegularTree(fixtures, root)
  return root
}

function changeReceipt(root, mutate) {
  const path = join(root, "summary.json")
  const receipt = JSON.parse(readFileSync(path, "utf8"))
  mutate(receipt)
  writeFileSync(path, JSON.stringify(receipt))
}

function bridge(root) {
  return spawnSync(
    "corepack",
    [
      "pnpm",
      "--filter",
      "@lyrashield/worker",
      "exec",
      "tsx",
      "../../scripts/verify-worker-writer-artifacts.ts",
      root,
    ],
    { cwd: repoRoot, encoding: "utf8", timeout: 30_000 }
  )
}

function rejected(result, message) {
  assert.ifError(result.error)
  assert.notEqual(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stderr, message)
}

test("accepts all 13 exact writer tuples as the positive control", () => {
  const result = bridge(fixtures)
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(result.stdout.match(/: PASS /g)?.length, 13)
})

for (const file of ["run.json", "vulnerabilities.json", "http_exchanges.json"]) {
  test(`rejects an omitted mandatory ${file} receipt even with parseable bytes`, () => {
    const root = copyFixtures()
    changeReceipt(root, (receipt) => delete receipt["reverse-reuse"].files[file])
    if (file === "run.json") {
      const path = join(root, "reverse-reuse", file)
      writeFileSync(path, readFileSync(path, "utf8") + " ")
    }
    rejected(bridge(root), /tuple files/)
  })
}

test("rejects same-length bytes with a mismatched receipt digest", () => {
  const root = copyFixtures()
  const path = join(root, "reverse-reuse", "run.json")
  const raw = readFileSync(path, "utf8")
  const changed = raw.replace('"1.2"', '"1.1"')
  assert.notEqual(changed, raw)
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength(raw))
  writeFileSync(path, changed)
  rejected(bridge(root), /SHA-256/)
})

test("rejects an HTTP file in a tuple that must have no HTTP artifact", () => {
  const root = copyFixtures()
  cpSync(
    join(root, "reverse-reuse", "http_exchanges.json"),
    join(root, "overflow-failed", "http_exchanges.json")
  )
  rejected(bridge(root), /HTTP artifact presence/)
})

const requiredFlags = [
  "--non-interactive",
  "--target",
  "--scan-mode",
  "--instruction",
  "--max-budget-usd",
  "--runtime-budget-seconds",
]

/** @param {{dirty?: string, untracked?: boolean, statusFails?: boolean, help?: string}} [options] */
function runGate({
  dirty,
  untracked = false,
  statusFails = false,
  help = requiredFlags.join("\n"),
} = {}) {
  const root = join(workspace, `gate-${sequence++}`)
  mkdirSync(join(root, "scripts"), { recursive: true })
  mkdirSync(join(root, "bin"))
  mkdirSync(join(root, "fixtures"))
  cpSync(
    join(repoRoot, "scripts", "verify-current-worker-contract.sh"),
    join(root, "scripts", "verify-current-worker-contract.sh")
  )
  writeFileSync(join(root, "scripts", "current-worker-contract-tests.txt"), "contract.test.ts\n")
  writeFileSync(join(root, "contract.test.ts"), "// disposable contract source\n")
  writeFileSync(join(root, "fixtures", "summary.json"), "{}")
  const marker = join(root, "corepack-calls")
  writeFileSync(
    join(root, "bin", "corepack"),
    '#!/usr/bin/env bash\nprintf "called\\n" >> "$QUALIFICATION_TEST_MARKER"\n',
    { mode: 0o700 }
  )
  const cli = join(root, "bin", "candidate-engine")
  writeFileSync(
    cli,
    `#!/usr/bin/env bash\ncat <<'QUALIFICATION_HELP'\n${help}\nQUALIFICATION_HELP\n`,
    { mode: 0o700 }
  )
  const git = (...args) => {
    const result = spawnSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
      { cwd: root, encoding: "utf8", timeout: 10_000 }
    )
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stdout + result.stderr)
  }
  git("init", "-q")
  git("add", ".")
  git(
    "-c",
    "user.name=Qualification fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "test fixture"
  )
  if (dirty) {
    writeFileSync(join(root, "contract.test.ts"), "// modified after the recorded HEAD\n")
    if (dirty === "staged") git("add", "contract.test.ts")
  }
  if (untracked) writeFileSync(join(root, "untracked-note.txt"), "local operator note\n")
  if (statusFails) writeFileSync(join(root, ".git", "index"), "invalid index fixture")
  const result = spawnSync(
    "bash",
    [join(root, "scripts", "verify-current-worker-contract.sh"), join(root, "fixtures")],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        LYRASHIELD_BIN: cli,
        QUALIFICATION_TEST_MARKER: marker,
      },
    }
  )
  return {
    result,
    calls: (() => {
      try {
        return readFileSync(marker, "utf8")
      } catch {
        return ""
      }
    })(),
  }
}

test("runs the gate for a clean checkout with all exact CLI option tokens", () => {
  const { result, calls } = runGate()
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(calls, "called\ncalled\ncalled\n")
})

test("allows untracked local files without weakening the tracked-source rule", () => {
  const { result, calls } = runGate({ untracked: true })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(calls, "called\ncalled\ncalled\n")
})

test("fails closed if Git cannot read tracked status", () => {
  const { result, calls } = runGate({ statusFails: true })
  rejected(result, /git status failed/)
  assert.equal(result.status, 2)
  assert.equal(calls, "")
})

for (const dirty of ["unstaged", "staged"]) {
  test(`rejects ${dirty} tracked source before installing or testing`, () => {
    const { result, calls } = runGate({ dirty })
    rejected(result, /local modifications/)
    assert.equal(result.status, 2)
    assert.equal(calls, "")
  })
}

for (const [missing, siblings] of [
  ["--target", ["--target-list", "--target-type"]],
  ["--instruction", ["--instruction-file"]],
]) {
  test(`rejects help with only prefix siblings of ${missing}`, () => {
    const { result, calls } = runGate({
      help: [...requiredFlags.filter((flag) => flag !== missing), ...siblings].join("\n"),
    })
    rejected(result, /Missing CLI flag required/)
    assert.equal(result.status, 1)
    assert.equal(calls, "")
  })
}
