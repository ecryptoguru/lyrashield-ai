import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

test("rolls traffic back when Azure reports that each previous revision is already active", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "lyra-rollout-recovery-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const bin = path.join(directory, "bin")
  const calls = path.join(directory, "az-calls")
  const curlCalls = path.join(directory, "curl-calls")
  mkdirSync(bin)
  writeFileSync(calls, "")
  writeFileSync(curlCalls, "")
  writeFileSync(
    path.join(bin, "az"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_AZ_CALLS"
if [ "$1 $2" = "containerapp show" ]; then
  case "$*" in
    *properties.configuration.ingress.fqdn*) printf 'egress.example.test\\n' ;;
    *) exit 91 ;;
  esac
elif [ "$1 $2 $3" = "containerapp revision activate" ]; then
  exit 1
elif [ "$1 $2 $3" = "containerapp revision show" ]; then
  case "$*" in
    *properties.active*) printf '%s\\n' "\${FAKE_REVISION_ACTIVE:-true}" ;;
    *) exit 91 ;;
  esac
elif [ "$1 $2 $3 $4" = "containerapp ingress traffic set" ]; then
  if [ "\${FAKE_TRAFFIC_SET_ERROR:-false}" = "true" ]; then exit 1; fi
elif [ "$1 $2 $3 $4" = "containerapp ingress traffic show" ]; then
  printf '%s\\n' "\${FAKE_TRAFFIC_WEIGHT:-0}"
elif [ "$1 $2 $3" = "vm run-command invoke" ]; then
  printf 'EGRESS_HEALTH_OK\\n'
else
  echo "Unexpected fake az call: $*" >&2
  exit 91
fi
`,
    { mode: 0o700 }
  )
  writeFileSync(
    path.join(bin, "curl"),
    '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$FAKE_CURL_CALLS"\n',
    { mode: 0o700 }
  )
  writeFileSync(path.join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 })
  writeFileSync(
    path.join(bin, "timeout"),
    '#!/usr/bin/env bash\nif [[ "$1" == --kill-after=* ]]; then shift; fi\nshift\nexec "$@"\n',
    { mode: 0o700 }
  )
  for (const name of ["az", "curl", "sleep", "timeout"]) chmodSync(path.join(bin, name), 0o700)

  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_AZ_CALLS: calls,
    FAKE_CURL_CALLS: curlCalls,
    APP_NAME: "fixture-app",
    APP_PREVIOUS: "fixture-app-old",
    APP_SMOKE_URL: "https://app.example.test/api/ready",
    SCANNER_NAME: "fixture-scanner",
    SCANNER_PREVIOUS: "fixture-scanner-old",
    SCANNER_SMOKE_URL: "https://scanner.example.test/api/ready",
    EGRESS_NAME: "fixture-egress",
    EGRESS_PREVIOUS: "fixture-egress-old",
    RG: "fixture-rg",
    WORKER_VM_NAME: "fixture-worker",
    FAKE_REVISION_ACTIVE: "true",
  }

  const output = execFileSync(
    "bash",
    [".github/scripts/deploy-azure-rollout.sh", "roll-back-production-traffic-on-health-failure"],
    { env, encoding: "utf8" }
  )
  const commands = readFileSync(calls, "utf8").split("\n").filter(Boolean)
  const smokeCalls = readFileSync(curlCalls, "utf8")

  assert.match(output, /Rollback readiness passed for fixture-app/)
  assert.match(output, /Rollback readiness passed for fixture-scanner/)
  assert.ok(
    commands.some((line) =>
      line.includes(
        "--name fixture-app --resource-group fixture-rg --revision-weight fixture-app-old=100"
      )
    )
  )
  assert.ok(
    commands.some((line) =>
      line.includes(
        "--name fixture-scanner --resource-group fixture-rg --revision-weight fixture-scanner-old=100"
      )
    )
  )
  assert.ok(
    commands.some((line) =>
      line.includes(
        "--name fixture-egress --resource-group fixture-rg --revision-weight fixture-egress-old=100"
      )
    )
  )
  assert.match(smokeCalls, /https:\/\/app\.example\.test\/api\/ready/)
  assert.match(smokeCalls, /https:\/\/scanner\.example\.test\/api\/ready/)
  assert.ok(commands.some((line) => line.includes("EGRESS_HEALTH_OK")))

  writeFileSync(calls, "")
  let appliedTrafficOutput
  let appliedTrafficError
  try {
    appliedTrafficOutput = execFileSync(
      "bash",
      [".github/scripts/deploy-azure-rollout.sh", "roll-back-production-traffic-on-health-failure"],
      {
        env: { ...env, FAKE_TRAFFIC_SET_ERROR: "true", FAKE_TRAFFIC_WEIGHT: "100" },
        encoding: "utf8",
      }
    )
  } catch (error) {
    appliedTrafficError = error
  }
  assert.equal(
    appliedTrafficError,
    undefined,
    "the traffic readback proves the rollback took effect"
  )
  assert.match(
    appliedTrafficOutput,
    /traffic readback confirms fixture-app-old=100 after Azure returned an error/
  )

  writeFileSync(calls, "")
  let failedRollback
  try {
    execFileSync(
      "bash",
      [".github/scripts/deploy-azure-rollout.sh", "roll-back-production-traffic-on-health-failure"],
      { env: { ...env, FAKE_REVISION_ACTIVE: "false" }, encoding: "utf8" }
    )
  } catch (error) {
    failedRollback = error
  }
  assert.ok(failedRollback)
  assert.match(failedRollback.stdout.toString(), /Manual recovery required/)
  const inactiveRevisionCommands = readFileSync(calls, "utf8")
  assert.doesNotMatch(inactiveRevisionCommands, /containerapp ingress traffic set/)
})
