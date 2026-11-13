// Opt-in native proof invokes the same Python module installed on production.
import { spawnSync } from "node:child_process"
const result = spawnSync("python3", [".github/scripts/tests/cold-start-barrier.native.py"], {
  stdio: "inherit",
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
