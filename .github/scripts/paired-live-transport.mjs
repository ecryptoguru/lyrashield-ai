import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import { OWNED_HOLD_LUA, SCAN_ADMISSION_KEY } from "../../ops/monitoring/paired-release-hold.mjs"
import { rebindLua, observeLua, armedReleaseLua } from "./paired-runtime-authority.mjs"
import { holdStateLua } from "./paired-runtime-hold.mjs"
const root = fileURLToPath(new URL("../../", import.meta.url))
const files = [
  ".github/scripts/paired-stage-store.py",
  ".github/scripts/paired-live-host.sh",
  ".github/scripts/paired-runtime-host-observation.py",
  "packages/security/src/runtime-qualification-key.json",
  ".github/scripts/paired-live-guest.mjs",
  ".github/scripts/v26-runtime-database.mjs",
  ".github/scripts/v26-execution-drain.sh",
  ".github/scripts/paired-runtime-hold.mjs",
  ".github/scripts/paired-runtime-authority.mjs",
  "ops/monitoring/paired-release-hold.mjs",
]
const phases = new Set([
  "stage-store",
  "runtime-authority",
  "rpc",
  "drain",
  "continuity",
  "relay",
  "accounted",
  "evidence",
  "worker",
  "stopped",
  "physical",
  "stop",
  "contain",
  "clear",
  "selector-absent",
  "armed-selector",
  "unused",
  "stage-sandbox",
])
function check(c) {
  if (!c) throw new Error("Unverified protected VM operation")
}
function git(...args) {
  try {
    return execFileSync("git", ["--no-replace-objects", ...args], {
      cwd: root,
      timeout: 5000,
      maxBuffer: 131072,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch {
    throw new Error("Trusted Git object unavailable")
  }
}
export function readGuestResult(raw, nonce) {
  let result
  try {
    result = JSON.parse(raw)
  } catch {
    throw new Error("Protected VM response invalid")
  }
  const rows = result.value
  check(
    Array.isArray(rows) &&
      rows.length <= 2 &&
      rows.every((r) => /^ComponentStatus\/Std(Out|Err)\/succeeded$/i.test(r.code))
  )
  const stdout = rows.filter((r) => /\/StdOut\//i.test(r.code))
  check(stdout.length === 1 && typeof stdout[0].message === "string")
  const lines = stdout[0].message
    .split(/(?:^|\n)\[stderr\]\r?(?:\n|$)/, 1)[0]
    .trimEnd()
    .split(/\r?\n/)
  const prefix = "PAIRED_RESULT " + nonce + " ",
    matches = lines.filter((s) => s.startsWith(prefix))
  check(matches.length === 1 && matches[0] === lines.at(-1))
  const b64 = matches[0].slice(prefix.length)
  check(/^[A-Za-z0-9+/=]{1,3000}$/.test(b64))
  const bytes = Buffer.from(b64, "base64")
  check(bytes.toString("base64") === b64)
  try {
    return JSON.parse(bytes)
  } catch {
    throw new Error("Protected VM payload invalid")
  }
}
export function guest(phase, params) {
  check(phases.has(phase))
  const body = JSON.stringify(params)
  check(Buffer.byteLength(body, "utf8") <= (phase === "stage-store" ? 16384 : 4096))
  const group = process.env.RG,
    vm = process.env.WORKER_VM_NAME,
    head = git("rev-parse", "HEAD").toString().trim()
  check(
    head === process.env.GITHUB_SHA &&
      /^[a-z0-9-]{1,64}$/i.test(vm) &&
      /^[a-z0-9_-]{1,90}$/i.test(group)
  )
  const nonce = randomBytes(32).toString("hex"),
    install = files
      .map((path) => {
        const blob = git("show", head + ":" + path)
        return `printf '%s' '${blob.toString("base64")}' | base64 -d > "$d/${path}"`
      })
      .join("\n")
  const cmd = `set -eu
umask 077
d=$(mktemp -d)
trap 'rm -rf -- "$d"' EXIT
mkdir -p "$d/.github/scripts" "$d/ops/worker" "$d/ops/monitoring" "$d/packages/security/src"
${install}
result=$(sh "$d/.github/scripts/paired-live-host.sh" '${phase}' '${Buffer.from(body).toString("base64")}' "$d")
[ "\${#result}" -le 2200 ]
printf 'PAIRED_RESULT %s %s\\n' '${nonce}' "$(printf '%s' "$result" | base64 -w0)"`
  let raw
  try {
    raw = execFileSync(
      "bash",
      [
        "-c",
        'source ops/deployment/azure-vm-run-command.sh; azure_vm_run_command_with_retry --name "$1" --resource-group "$2" --command-id RunShellScript --scripts "$3" --output json',
        "_",
        vm,
        group,
        cmd,
      ],
      {
        cwd: root,
        timeout: phase === "stage-sandbox" ? 1350000 : 195000,
        maxBuffer: 32768,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          AZURE_VM_RUN_COMMAND_TIMEOUT_SECONDS: phase === "stage-sandbox" ? "1300" : "150",
        },
      }
    )
  } catch {
    throw new Error("Protected VM operation unconfirmed")
  }
  return readGuestResult(raw, nonce)
}
export const liveRedis = {
  set: async (key, value, flag) => {
    check(key === SCAN_ADMISSION_KEY && flag === "NX")
    return guest("rpc", ["nx", value])
  },
  eval: async (lua, count, key, ...args) => {
    check(count === 1 && key === SCAN_ADMISSION_KEY)
    if (lua === OWNED_HOLD_LUA) {
      check(["assert", "release"].includes(args[0]) && args.length === 2)
      return guest("rpc", args)
    }
    const op = new Map([
      [holdStateLua, "state"],
      [rebindLua, "rebind"],
      [observeLua, "observe"],
      [armedReleaseLua, "armed-release"],
    ]).get(lua)
    check(op)
    return guest("rpc", [op, ...args])
  },
}
