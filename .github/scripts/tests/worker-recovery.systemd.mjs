// Opt-in proof on a disposable Linux runner. Only UUID-owned transient units are touched.
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import assert from "node:assert/strict"

if (process.env.LYRASHIELD_RUN_ISOLATED_SYSTEMD_PROOF !== "1" || process.platform !== "linux") {
  throw new Error(
    "Use LYRASHIELD_RUN_ISOLATED_SYSTEMD_PROOF=1 on a disposable Linux systemd runner"
  )
}
const run = (program, args) =>
  execFileSync("sudo", ["-n", program, ...args], { encoding: "utf8", timeout: 30000 })
const waitFor = async (predicate) => {
  for (let i = 0; i < 60; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error("Owned transient recovery did not reach expected state")
}
for (const mismatch of [false, true]) {
  const prefix = `lyrashield-recovery-proof-${randomUUID()}`
  const worker = `${prefix}-worker.service`,
    base = `${prefix}-docker.service`,
    recovery = `${prefix}-recover.service`
  const directory = mkdtempSync(join(tmpdir(), "lyrashield-systemd-proof-"))
  const epoch = join(directory, "epoch"),
    count = join(directory, "count"),
    held = join(directory, "held"),
    done = join(directory, "done")
  const workerScript = join(directory, "worker.sh"),
    recoveryScript = join(directory, "recover.sh")
  writeFileSync(epoch, mismatch ? "changed" : "original")
  writeFileSync(
    workerScript,
    `#!/bin/sh\nif [ ! -e '${count}' ]; then echo 1 > '${count}'; exit 1; fi\necho 2 > '${count}'\nexec /bin/sleep infinity\n`,
    { mode: 0o755 }
  )
  writeFileSync(
    recoveryScript,
    `#!/bin/sh\nset -eu\nif [ "$(cat '${epoch}')" != original ]; then echo held > '${held}'; exit 1; fi\n# Recovery is deliberately independent of the worker's required native daemon.\nsystemctl stop '${base}'\nsystemctl start '${base}'\nsystemctl reset-failed '${worker}'\nsystemctl start '${worker}'\necho done > '${done}'\n`,
    { mode: 0o755 }
  )
  try {
    // Timer creates an inactive transient callback service before OnFailure references it.
    run("systemd-run", [
      `--unit=${recovery.slice(0, -8)}`,
      "--on-active=3600s",
      "--property=Type=oneshot",
      "--property=Restart=no",
      "--property=StartLimitIntervalSec=300",
      "--property=StartLimitBurst=1",
      recoveryScript,
    ])
    run("systemd-run", [
      `--unit=${base.slice(0, -8)}`,
      "--on-active=3600s",
      "/bin/sleep",
      "infinity",
    ])
    run("systemctl", ["start", base])
    run("systemd-run", [
      `--unit=${worker.slice(0, -8)}`,
      "--on-active=3600s",
      "--property=Restart=always",
      "--property=RestartSec=100ms",
      "--property=StartLimitBurst=1",
      `--property=Requires=${base}`,
      `--property=OnFailure=${recovery}`,
      workerScript,
    ])
    // The injected first failure can finish before the initial start job returns.
    try {
      run("systemctl", ["start", worker])
    } catch {}
    await waitFor(() => existsSync(mismatch ? held : done))
    if (mismatch) {
      assert.equal(readFileSync(count, "utf8").trim(), "1")
      assert.notEqual(
        run("systemctl", ["show", worker, "--property=ActiveState", "--value"]).trim(),
        "active"
      )
      assert.equal(readFileSync(epoch, "utf8"), "changed")
    } else {
      await waitFor(() => readFileSync(count, "utf8").trim() === "2")
      assert.equal(
        run("systemctl", ["show", worker, "--property=ActiveState", "--value"]).trim(),
        "active"
      )
      assert.equal(readFileSync(epoch, "utf8"), "original")
      assert.ok(!existsSync(held))
    }
    console.log(
      JSON.stringify({
        transientSystemdRecovery: mismatch ? "MISMATCH_HELD" : "ONE_RESTART_PASSED",
        owner: prefix,
      })
    )
  } finally {
    for (const unit of [
      worker,
      `${prefix}-worker.timer`,
      recovery,
      `${prefix}-recover.timer`,
      base,
      `${prefix}-docker.timer`,
    ]) {
      try {
        run("systemctl", ["stop", unit])
      } catch {}
      try {
        run("systemctl", ["reset-failed", unit])
      } catch {}
    }
    rmSync(directory, { recursive: true, force: true })
  }
}
