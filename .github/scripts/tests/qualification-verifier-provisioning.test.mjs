/* Test files are confined to freshly allocated fixture directories. */
/* eslint-disable security/detect-non-literal-fs-filename */
import assert from "node:assert/strict"
import test from "node:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("protected verifier provisioning checks both hashes before install and fails closed", () => {
  const source = readFileSync(".github/scripts/prepare-qualification-verifier.sh", "utf8")
  assert.match(
    source,
    /--proto '=https' --tlsv1.2 --fail --location --retry 2 --connect-timeout 20 --max-time 180/
  )
  assert.match(source, /sudo install -o root -g root -m 0755 "\$binary" \/usr\/bin\/gh/)
  const dir = mkdtempSync(join(tmpdir(), "qualification-verifier-test-"))
  const bin = join(dir, "bin"),
    log = join(dir, "log")
  mkdirSync(bin)
  const commands = {
    uname: 'case "$1" in -s) echo Linux;; -m) echo "${TEST_ARCH:-x86_64}";; esac',
    curl: 'printf "curl\\n" >> "$TEST_LOG"; while [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then printf fixture > "$2"; exit; fi; shift; done; exit 1',
    sha256sum:
      'input=$(cat); printf "hash %s\\n" "$input" >> "$TEST_LOG"; case "$TEST_FAILURE/$input" in archive/25d1*|binary/62c11*) exit 1;; esac',
    tar: '[ "$5" = gh_2.95.0_linux_amd64/bin/gh ] || exit 1; printf "tar %s\\n" "$5" >> "$TEST_LOG"; mkdir -p "$4/gh_2.95.0_linux_amd64/bin"; if [ "$TEST_FAILURE" = symlink ]; then ln -s /foreign "$4/$5"; else printf fixture > "$4/$5"; fi',
    sudo: 'printf "install %s\\n" "$*" >> "$TEST_LOG"; [ "$TEST_FAILURE" != install ]',
    stat: 'printf "%s\\n" "${TEST_OWNER:-0}"',
    // Leave exact owned fixture trees for coordinator cleanup; no real delete.
    rm: 'printf "cleanup %s\\n" "$*" >> "$TEST_LOG"',
  }
  for (const [name, body] of Object.entries(commands))
    writeFileSync(join(bin, name), "#!/bin/sh\nset -eu\n" + body + "\n", { mode: 0o700 })
  for (const failure of [
    "none",
    "archive",
    "binary",
    "symlink",
    "install",
    "owner",
    "architecture",
  ]) {
    writeFileSync(log, "")
    const result = spawnSync("bash", [".github/scripts/prepare-qualification-verifier.sh"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: bin + ":" + process.env.PATH,
        RUNNER_TEMP: dir,
        TEST_LOG: log,
        TEST_FAILURE: failure,
        TEST_OWNER: failure === "owner" ? "1000" : "0",
        TEST_ARCH: failure === "architecture" ? "arm64" : "x86_64",
      },
    })
    assert.equal(result.status === 0, failure === "none", failure + ": " + result.stderr)
    const events = readFileSync(log, "utf8").trim().split("\n")
    const install = events.findIndex((event) => event.startsWith("install "))
    if (["none", "install", "owner"].includes(failure)) {
      assert.ok(install >= 0)
      assert.equal(events.slice(0, install).filter((event) => event.startsWith("hash ")).length, 2)
    } else assert.equal(install, -1)
    if (failure === "none")
      assert.equal(events.filter((event) => event.startsWith("hash ")).length, 3)
  }
})
