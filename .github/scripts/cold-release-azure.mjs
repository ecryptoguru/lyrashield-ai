// Protected same-run Azure orchestration. No host GitHub verifier or paid POST retry.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { assertColdReleaseCaller } from "./assert-cold-release-caller.mjs"

const sourcePayload = (relative) => {
  // Paths below are fixed reviewed release assets.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(new URL(relative, import.meta.url)).toString("base64")
}
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"
export function coldIdentity(environment = process.env) {
  assertColdReleaseCaller(environment)
  const identity = {
    owner: environment.GITHUB_RUN_ID + ":" + environment.GITHUB_RUN_ATTEMPT,
    product: environment.DEPLOY_SHA,
    engine: environment.ENGINE_REVISION,
    image: environment.WORKER_IMAGE.replace(/@.*$/, "") + "@" + environment.WORKER_DIGEST,
    sandbox: environment.COLD_SANDBOX_IMAGE,
    vault: environment.AZURE_APP_SECRET_KEY_VAULT_NAME,
  }
  assert.match(identity.owner, /^[1-9][0-9]{0,19}:[1-9][0-9]{0,9}$/)
  assert.match(identity.engine, /^[a-f0-9]{40}$/)
  assert.match(
    identity.image,
    /^ghcr\.io\/ecryptoguru\/lyrashield-ai\/lyrashield-worker(?::[^@\s]+)?@sha256:[a-f0-9]{64}$/
  )
  assert.match(identity.sandbox, /^ghcr\.io\/ecryptoguru\/lyrashield-sandbox@sha256:[a-f0-9]{64}$/)
  assert.match(identity.vault, /^[A-Za-z][A-Za-z0-9-]{1,22}[A-Za-z0-9]$/)
  return identity
}

export function coldHostScript(operation, identity, payload = "") {
  assert.ok(["prepare", "promote", "open", "contain", "proof", "finish"].includes(operation))
  if (["proof", "finish"].includes(operation)) assert.match(payload, /^[A-Za-z0-9_-]{1,16384}$/)
  const state = "/var/lib/lyrashield/cold-release-" + identity.owner
  const tuple = Buffer.from(JSON.stringify(identity)).toString("base64")
  const prefix = `set -eu\numask 077\nstate=${quote(state)}\n`
  const contextCheck = `
/usr/bin/python3 - "$state/context.json" ${quote(tuple)} <<'PYCONTEXT'
import base64,json,os,stat,sys
path,expected=sys.argv[1:]
fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
with os.fdopen(fd) as stream:
 metadata=os.fstat(stream.fileno())
 if metadata.st_uid!=0 or stat.S_IMODE(metadata.st_mode)!=0o600: raise SystemExit(1)
 actual=json.load(stream)
 if actual['identity']!=json.loads(base64.b64decode(expected)): raise SystemExit(1)
PYCONTEXT
old_worker=$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["oldWorker"])' "$state/context.json")
old_sandbox=$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["oldSandbox"])' "$state/context.json")
`
  const promote = (flag) =>
    `LYRASHIELD_WORKER_ENV_LIB="$state/worker-env.sh" LYRASHIELD_WORKER_GITHUB_CREDENTIAL_VAULT=${quote(identity.vault)} LYRASHIELD_PAIRED_RELEASE_OWNER=${quote(identity.owner)} LYRASHIELD_PAIRED_RELEASE_HOLD_MODULE_BASE64=${quote(sourcePayload("../../ops/monitoring/paired-release-hold.mjs"))} LYRASHIELD_COLD_OLD_SANDBOX_IMAGE="$old_sandbox" sh "$state/promote.sh" ${flag} "$old_worker" ${quote(identity.image)} ${quote(identity.product)} ${quote(identity.engine)} ${quote(identity.sandbox)}\n`
  const proof = `
[ "$(docker inspect lyrashield-worker --format '{{.Image}}')" = "$(docker image inspect ${quote(identity.image)} --format '{{.Id}}')" ]
[ "$(docker exec lyrashield-worker printenv LYRASHIELD_PRODUCT_REVISION)" = ${quote(identity.product)} ]
[ "$(docker exec lyrashield-worker printenv LYRASHIELD_ENGINE_REVISION)" = ${quote(identity.engine)} ]
docker exec -i -w /app/apps/worker lyrashield-worker node --import tsx --input-type=module - ${quote(payload)} < "$state/proof.mjs" > "$state/proof-result.json"
printf 'COLD_PROOF:'
base64 -w 0 "$state/proof-result.json"
printf '\\n'
`
  if (operation === "prepare") {
    return (
      prefix +
      `
[ ! -e /var/lib/lyrashield/cold-acceptance-pending.json ]
[ ! -L "$state" ]
mkdir -m 0700 "$state"
old_worker=$(sed -n 's/^LYRASHIELD_WORKER_IMAGE=//p' /etc/lyrashield/worker-runtime.conf)
old_sandbox=$(sed -n 's/^LYRASHIELD_SANDBOX_IMAGE=//p' /etc/lyrashield/worker-runtime.conf)
/usr/bin/python3 - "$state/context.json" ${quote(tuple)} "$old_worker" "$old_sandbox" <<'PYCREATE'
import base64,json,os,re,sys
path,identity,worker,sandbox=sys.argv[1:]
for image in (worker,sandbox):
 if not re.fullmatch(r'ghcr.io/ecryptoguru/[A-Za-z0-9_./:-]+@sha256:[a-f0-9]{64}',image): raise SystemExit(1)
fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
with os.fdopen(fd,'w') as output:
 json.dump(dict(identity=json.loads(base64.b64decode(identity)),oldWorker=worker,oldSandbox=sandbox),output);output.flush();os.fsync(output.fileno())
fd=os.open(os.path.dirname(path),os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)
PYCREATE
` +
      [
        ["promote.sh", "./promote-worker-vm.sh"],
        ["worker-env.sh", "../../ops/worker/worker-env.sh"],
        ["proof.mjs", "./cold-unpaid-canary-proof.mjs"],
      ]
        .map(
          ([name, path]) =>
            `printf '%s' ${quote(sourcePayload(path))} | base64 -d > "$state/${name}"\n`
        )
        .join("") +
      `
[ ! -L /opt/lyrashield-worker-host ]
install -d -m 0755 /opt/lyrashield-worker-host
printf '%s' ${quote(sourcePayload("../../ops/worker/cold-start-barrier.py"))} | base64 -d > "$state/barrier.py"
printf '%s' ${quote(sourcePayload("./cold-release-host.py"))} | base64 -d > "$state/host.py"
install -o root -g root -m 0755 "$state/barrier.py" /opt/lyrashield-worker-host/cold-start-barrier.py
install -o root -g root -m 0755 "$state/host.py" /opt/lyrashield-worker-host/cold-release-host.py
` +
      promote("--cold-prepare") +
      "echo COLD_AZURE_OK\n"
    )
  }
  let script = prefix + contextCheck
  if (operation === "proof" || operation === "finish") script += proof
  else
    script += promote(
      {
        promote: "--cold-release-stopped",
        open: "--cold-open-admission",
        contain: "--cold-contain",
      }[operation]
    )
  if (operation === "finish")
    script += `
/usr/bin/python3 - "$state/proof-result.json" ${quote(payload)} /var/lib/lyrashield/cold-acceptance-pending.json ${quote(identity.owner)} ${quote(identity.product)} ${quote(identity.engine)} ${quote(identity.image)} <<'PYFINISH'
import base64,json,os,sys
proof_path,payload,path,owner,product,engine,image=sys.argv[1:]
expected=json.loads(base64.urlsafe_b64decode(payload+'='*(-len(payload)%4)))
with open(proof_path) as source:
 proof=json.load(source)
 if proof.get('version')!=1 or proof.get('result')!='MATCH': raise SystemExit(1)
 for field in ('scanId','operationId','checksum','productRevision','engineRevision','workerDigest'):
  if proof.get(field)!=expected.get(field): raise SystemExit(1)
 if proof['productRevision']!=product or proof['engineRevision']!=engine or proof['workerDigest']!=image.split('@')[1]: raise SystemExit(1)
with open(path) as source:
 if json.load(source)!=dict(owner=owner,productRevision=product,engineRevision=engine,workerImage=image,state='acceptance-pending'): raise SystemExit(1)
os.rename(path,${quote(state + "/accepted.json")})
for directory in (os.path.dirname(path),${quote(state)}):
 fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)
PYFINISH
`
  return script + "echo COLD_AZURE_OK\n"
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const operation = process.argv[2]
    const identity = coldIdentity()
    execFileSync("bash", [".github/scripts/assert-current-main.sh"], {
      stdio: "inherit",
      env: { ...process.env, SOURCE_SHA: identity.product },
    })
    let payload = process.argv[3] ?? ""
    if (operation === "finish") {
      const receipt = JSON.parse(
        readFileSync(process.env.RUNNER_TEMP + "/cold-unpaid-canary.json", "utf8")
      )
      assert.equal(receipt.productRevision, identity.product)
      assert.equal(receipt.engineRevision, identity.engine)
      assert.equal(receipt.workerDigest, process.env.WORKER_DIGEST)
      payload = Buffer.from(JSON.stringify(receipt.proofPayload)).toString("base64url")
    }
    const script = coldHostScript(operation, identity, payload)
    const response = JSON.parse(
      execFileSync(
        "az",
        [
          "vm",
          "run-command",
          "invoke",
          "--name",
          process.env.WORKER_VM_NAME,
          "--resource-group",
          process.env.RG,
          "--command-id",
          "RunShellScript",
          "--scripts",
          script,
          "--output",
          "json",
          "--only-show-errors",
        ],
        { timeout: 1800000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }
      ).toString()
    )
    const message = response.value?.map((entry) => entry.message).join("\n")
    assert.ok(typeof message === "string" && /^COLD_AZURE_OK$/m.test(message))
    if (operation === "proof" || operation === "finish") {
      const matches = [...message.matchAll(/^COLD_PROOF:([A-Za-z0-9+/=]+)$/gm)]
      assert.equal(matches.length, 1)
      const result = JSON.parse(Buffer.from(matches[0][1], "base64").toString())
      if (operation === "proof") process.stdout.write(JSON.stringify(result) + "\n")
      else console.log("Cold release completed with exact-image unpaid acceptance")
    } else console.log("Cold Azure operation completed: " + operation)
  } catch {
    console.error("Cold Azure operation failed; admission must remain held on uncertainty")
    process.exitCode = 1
  }
}
