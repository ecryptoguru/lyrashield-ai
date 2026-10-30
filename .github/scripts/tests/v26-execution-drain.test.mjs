import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

function probe(mode) {
  const directory = mkdtempSync(join(tmpdir(), "lyrashield-v26-drain-"))
  try {
    const docker = join(directory, "docker")
    // Both executables live in a freshly created test-owned directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(
      docker,
      `#!/bin/sh
case "${mode}:$*" in
  fail:*) exit 1 ;;
  sandbox:*label=strix-run-id*) echo active-container ;;
  resolver:*name=lyrashield-go-*) echo active-container ;;
esac
`
    )
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    chmodSync(docker, 0o755)
    const timeout = join(directory, "timeout")
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(timeout, '#!/bin/sh\nshift\nexec "$@"\n')
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    chmodSync(timeout, 0o755)
    return spawnSync("sh", [".github/scripts/v26-execution-drain.sh"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test("requires both sandbox and resolver processes to be absent", () => {
  const result = probe("clear")
  assert.equal(result.status, 0)
  assert.match(result.stdout, /^V26_EXECUTION_DRAIN_VERIFIED\s*$/)
  for (const mode of ["sandbox", "resolver", "fail"]) {
    const blocked = probe(mode)
    assert.equal(blocked.status, 1, mode)
    assert.doesNotMatch(blocked.stdout, /VERIFIED/, mode)
    assert.doesNotMatch(blocked.stderr, /active-container/, mode)
  }
})
