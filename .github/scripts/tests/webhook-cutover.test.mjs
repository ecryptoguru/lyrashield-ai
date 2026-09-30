import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

const script = path.resolve(".github/scripts/verify-webhook-cutover.mjs")
const product = "a".repeat(40)
const engine = "b".repeat(40)
const digest = `sha256:${"c".repeat(64)}`
const image = `ghcr.io/example/worker:${product}@${digest}`
const protocol = "durable-claims/1"

function fixture(t, scenario) {
  const directory = mkdtempSync(path.join(tmpdir(), "ls-webhook-cutover-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const revisions = [
    {
      properties: {
        active: true,
        template: {
          containers: [{ image, env: [{ name: "LYRASHIELD_PRODUCT_REVISION", value: product }] }],
        },
      },
    },
  ]
  const state = { protocol, product, engine, digest, migrated: true }
  if (scenario === "pending migration") state.migrated = false
  if (scenario === "old worker") state.protocol = "legacy"
  if (scenario === "no active app") revisions[0].properties.active = false
  if (scenario === "image mismatch")
    revisions[0].properties.template.containers[0].image = "image:latest"
  if (scenario === "missing provenance") state.engine = undefined
  const message = `WORKER_ROLLBACK_IMAGE=${scenario === "rollback mismatch" ? "legacy" : image}\nWORKER_IMAGE=${image}\nWORKER_PRODUCT=${product}\nWORKER_ENGINE=${engine}\n${JSON.stringify(state)}`
  const executable = (name, body) => {
    const file = path.join(directory, name)
    writeFileSync(file, `#!${process.execPath}\n${body}`)
    chmodSync(file, 0o755)
  }
  executable("systemctl", "process.exit(0)")
  executable(
    "sed",
    `console.log(${JSON.stringify(scenario === "rollback mismatch" ? "legacy" : image)})`
  )
  executable(
    "docker",
    `const args=process.argv.slice(2); if(args[0]==="login") process.exit(0); if(args[0]==="buildx") { console.log(JSON.stringify({config:{Labels:{"org.opencontainers.image.revision":${JSON.stringify(scenario === "OCI mismatch" ? "legacy" : product)}}}})); } else if(args[0]==="inspect") { const format=args[2]; console.log(format.includes("State.Running")?"true":format.includes("Config.Image")?${JSON.stringify(image)}:format.includes("engine.revision")?${JSON.stringify(engine)}:${JSON.stringify(product)}); } else if(args[0]==="exec") { const code=args.at(-1); const state=${JSON.stringify(state)}; process.env.LYRASHIELD_PRODUCT_REVISION=state.product; process.env.LYRASHIELD_WORKER_IMAGE_DIGEST=state.digest; if(state.engine) process.env.LYRASHIELD_ENGINE_REVISION=state.engine; else delete process.env.LYRASHIELD_ENGINE_REVISION; const prisma={$queryRawUnsafe:async(query,...parameters)=>{ const matched=query.includes("migration_name = $1")?parameters[0]==="20260930120000_webhook_track_claims":query.includes(${JSON.stringify("migration_name = '20260930120000_webhook_track_claims'")}); if(!matched) throw new Error("Migration identity lost in shell transport"); return [{count:state.migrated?1:0}]; },$disconnect:async()=>{}}; const load=async(name)=>name==="@lyrashield/billing"?{WEBHOOK_TRACK_CLAIM_PROTOCOL:state.protocol}:name==="@lyrashield/db"?{getSystemPrisma:()=>prisma}:Promise.reject(new Error("Unexpected module")); new Function("load","return (async()=>{"+code.replaceAll("import(","load(")+"})()")(load).catch(error=>{console.error(error.message);process.exit(1)}); } else process.exit(1);`
  )
  executable(
    "az",
    `const {spawnSync}=require("node:child_process"); const args=process.argv.slice(2); if(args[0]==="keyvault") console.log("synthetic-registry-token"); else if(args[0]==="containerapp") console.log(${JSON.stringify(JSON.stringify(revisions))}); else { if(${JSON.stringify(scenario)}==="VM failure") process.exit(1); const result=spawnSync("sh",["-c",args[args.indexOf("--scripts")+1]],{encoding:"utf8"}); process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.status); }`
  )
  executable(
    "git",
    `if(process.argv[2]==="show") console.log(${JSON.stringify(scenario === "old app" ? "legacy" : `export const WEBHOOK_TRACK_CLAIM_PROTOCOL = "${protocol}"`)});`
  )
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      AZURE_KEY_VAULT_NAME: "vault",
      GHCR_USERNAME: "owner",
      AZURE_RESOURCE_GROUP: "test",
      AZURE_WORKER_VM_NAME: "worker",
      AZURE_APP_CONTAINER_APP_NAME: "app",
      AZURE_SCANNER_CONTAINER_APP_NAME: "scanner",
    },
  })
}

test("compatible migration, active writers and immutable worker permit ordinary release", (t) => {
  const result = fixture(t, "compatible")
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /baseline verified/)
})
for (const scenario of [
  "pending migration",
  "old worker",
  "no active app",
  "image mismatch",
  "missing provenance",
  "rollback mismatch",
  "old app",
  "OCI mismatch",
  "VM failure",
]) {
  test(`cutover fails closed: ${scenario}`, (t) => assert.notEqual(fixture(t, scenario).status, 0))
}

test("guard precedes configuration and migration mutations in protected production job", () => {
  const workflow = readFileSync(".github/workflows/deploy-azure-runtime.yml", "utf8")
  const gate = workflow.indexOf("- name: Verify compatible webhook cutover baseline")
  assert.ok(gate > workflow.indexOf("name: azure-production"))
  for (const step of [
    "Ensure app and scanner system identities",
    "Prepare private registry and zero-downtime rollout",
    "Run database migrations",
    "Promote healthy candidate revisions",
    "Promote verified worker digest on VM",
  ]) {
    assert.ok(gate < workflow.indexOf(`- name: ${step}`), step)
  }
  assert.doesNotMatch(readFileSync(script, "utf8"), /BYPASS|ALLOW_UNSAFE|CONFIRMATION/)
})

test("web images bind the exact source revision into OCI provenance", () => {
  const workflow = readFileSync(".github/workflows/deploy-azure.yml", "utf8")
  const web = workflow.slice(
    workflow.indexOf("- name: Build and push web image"),
    workflow.indexOf("- name: Build and push worker image")
  )
  assert.match(web, /org\.opencontainers\.image\.revision=\$\{\{ env\.DEPLOY_SHA \}\}/)
})
