import { readFileSync } from "node:fs"
import assert from "node:assert/strict"
import test from "node:test"
const resolver = readFileSync("apps/worker/src/engine/scanners/go-module-resolver.ts", "utf8")
const runner = readFileSync("ops/worker/run-worker.sh", "utf8")
test("host provisions and qualifies exactly the isolated resolver image before starting the worker", () => {
  const image = resolver.match(/GO_RESOLVER_IMAGE\s*=\s*"([^"]+)"/)?.[1]
  assert.match(image, /^golang:1\.26\.8-alpine@sha256:[a-f0-9]{64}$/)
  assert.ok(runner.includes(`go_resolver_image='${image}'`))
  assert.ok(runner.includes('timeout --foreground 60s docker pull "$go_resolver_image"'))
  assert.ok(runner.includes("--network=none --read-only --cap-drop=ALL"))
  assert.ok(runner.includes('"$go_resolver_image" version'))
  assert.ok(runner.indexOf('"$go_resolver_image" version') < runner.indexOf("worker_shared_root="))
})

import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
for (const mode of ["cached", "missing", "pull-failed", "wrong-version", "run-failed"]) {
  test(`launcher Go qualification: ${mode}`, () => {
    const root = mkdtempSync(join(tmpdir(), "go-image-contract-"))
    try {
      writeFileSync(join(root, "timeout"), '#!/bin/sh\nshift 2\nexec "$@"\n')
      writeFileSync(
        join(root, "docker"),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_LOG"
case "$1" in
 image) [ "$TEST_MODE" = cached ] ;;
 pull) [ "$TEST_MODE" != pull-failed ] ;;
 run) [ "$TEST_MODE" != run-failed ] || exit 1
      if [ "$TEST_MODE" = wrong-version ]; then printf 'go version go1.25.0 linux/amd64\\n'; else printf 'go version go1.26.8 linux/amd64\\n'; fi ;;
 rm) exit 0 ;;
 *) exit 99 ;;
esac
`
      )
      chmodSync(join(root, "timeout"), 0o755)
      chmodSync(join(root, "docker"), 0o755)
      const block = runner
        .split("# BEGIN GO RESOLVER QUALIFICATION")[1]
        .split("# END GO RESOLVER QUALIFICATION")[0]
      const result = spawnSync("sh", ["-ec", block], {
        encoding: "utf8",
        env: {
          PATH: `${root}:${process.env.PATH}`,
          TEST_MODE: mode,
          TEST_LOG: join(root, "calls"),
        },
      })
      assert.equal(result.status, ["cached", "missing"].includes(mode) ? 0 : 1, result.stderr)
      const calls = readFileSync(join(root, "calls"), "utf8")
      assert.equal(calls.includes("pull "), mode !== "cached")
      assert.equal(calls.includes("run --rm"), mode !== "pull-failed")
      if (mode === "run-failed")
        assert.ok(calls.includes("rm --force lyrashield-go-qualification-"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
test("worker egress only enables the fixed HTTPS Go metadata origin", () => {
  const egress = readFileSync("ops/worker/refresh-egress.sh", "utf8")
  assert.ok(egress.includes('register_approved_endpoint "https://proxy.golang.org" 443'))
  assert.ok(egress.includes('append_endpoint_rules "https://proxy.golang.org" 443'))
})
