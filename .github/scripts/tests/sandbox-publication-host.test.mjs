/* Test files are confined to freshly allocated fixture directories. */
/* eslint-disable security/detect-non-literal-fs-filename */
import assert from "node:assert/strict"
import test from "node:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const source = readFileSync("ops/worker/run-worker.sh", "utf8")
const boundary = source.indexOf(': "${LYRASHIELD_WORKER_IMAGE:')
assert.ok(boundary > 0)

test("host validates fixed root-owned read-only record before any runtime operation", () => {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-publication-host-"))
  const fixed = join(dir, "record.json")
  const library = join(dir, "loader.sh"),
    envFile = join(dir, "worker.env"),
    config = join(dir, "runtime.conf")
  mkdirSync(join(dir, "bin"))
  writeFileSync(library, "")
  writeFileSync(envFile, "")
  writeFileSync(fixed, "{}", { mode: 0o444 })
  writeFileSync(join(dir, "bin/stat"), '#!/bin/sh\nprintf "%s\\n" "$TEST_OWNER_MODE"\n', {
    mode: 0o700,
  })
  const prefix = source
    .slice(0, boundary)
    .replaceAll("/etc/lyrashield/sandbox-publication-record.json", fixed)
  const script = join(dir, "admission.sh")
  writeFileSync(script, prefix + 'printf "%s\\n" "$publication_record_mount"\n')
  for (const [path, ownerMode, succeeds] of [
    [fixed, "0:444", true],
    [fixed, "1000:444", false],
    [fixed, "0:644", false],
    [fixed + ",rw", "0:444", false],
    ["/tmp/untrusted.json", "0:444", false],
  ]) {
    writeFileSync(config, "LYRASHIELD_SANDBOX_PUBLICATION_RECORD_PATH='" + path + "'\n")
    const result = spawnSync("sh", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: join(dir, "bin") + ":" + process.env.PATH,
        TEST_OWNER_MODE: ownerMode,
        LYRASHIELD_WORKER_RUNTIME_CONFIG: config,
        LYRASHIELD_WORKER_ENV_LIB: library,
        LYRASHIELD_WORKER_ENV_FILE: envFile,
      },
    })
    assert.equal(result.status, succeeds ? 0 : 1)
    if (succeeds)
      assert.equal(
        result.stdout.trim(),
        "--mount type=bind,src=" + fixed + ",dst=" + fixed + ",readonly"
      )
  }
  writeFileSync(config, "")
  const inherited = spawnSync("sh", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      LYRASHIELD_WORKER_RUNTIME_CONFIG: config,
      LYRASHIELD_WORKER_ENV_LIB: library,
      LYRASHIELD_WORKER_ENV_FILE: envFile,
      LYRASHIELD_SANDBOX_PUBLICATION_RECORD_PATH: fixed,
    },
  })
  assert.equal(inherited.status, 0)
  assert.equal(inherited.stdout.trim(), "")
  assert.match(source.slice(source.indexOf("docker create")), /\$publication_record_mount \\\n/)
})

test("shared environment loader accepts only configured fixed record path and preserves legacy hold", () => {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-publication-env-"))
  const config = join(dir, "runtime.conf"),
    envFile = join(dir, "worker.env")
  writeFileSync(envFile, "")
  writeFileSync(
    join(dir, "docker"),
    '#!/bin/sh\nprintf "%s\\n" aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n',
    { mode: 0o700 }
  )
  const base =
    "LYRASHIELD_WORKER_IMAGE=ghcr.io/example/worker@sha256:" +
    "a".repeat(64) +
    "\n" +
    "LYRASHIELD_SANDBOX_IMAGE=ghcr.io/example/sandbox@sha256:" +
    "b".repeat(64) +
    "\n"
  for (const path of [
    "/etc/lyrashield/sandbox-publication-record.json",
    "/tmp/foreign",
    "/etc/lyrashield/sandbox-publication-record.json,rw",
    undefined,
  ]) {
    writeFileSync(
      config,
      base + (path ? "LYRASHIELD_SANDBOX_PUBLICATION_RECORD_PATH='" + path + "'\n" : "")
    )
    const result = spawnSync(
      "sh",
      [
        "-c",
        '. "$1"; lyrashield_worker_env_args "$2" "$3"',
        "fixture",
        resolve("ops/worker/worker-env.sh"),
        config,
        envFile,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: dir + ":" + process.env.PATH,
          LYRASHIELD_SANDBOX_PUBLICATION_RECORD_PATH:
            "/etc/lyrashield/sandbox-publication-record.json",
        },
      }
    )
    assert.equal(result.status === 0, path === "/etc/lyrashield/sandbox-publication-record.json")
    if (result.status === 0) {
      assert.match(
        result.stdout,
        /--env LYRASHIELD_SANDBOX_PUBLICATION_RECORD_PATH=\/etc\/lyrashield\/sandbox-publication-record.json/
      )
      assert.doesNotMatch(result.stdout, /SBOM_COVERAGE_VERIFY_PATH/)
    }
  }
})
