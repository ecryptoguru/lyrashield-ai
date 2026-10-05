// Read-only acceptance check for the separately approved root installation.
import { spawnSync } from "node:child_process"
import { lstatSync, realpathSync } from "node:fs"
import { checkParents } from "../../packages/db/scripts/webhook-empty-state-root-store.mjs"
import { requireValue } from "../../packages/db/scripts/webhook-empty-state-receipt-v2.mjs"
import { loadFixedMigrationEnvironment } from "./webhook-empty-state-migration-env.mjs"
export const BUNDLE = "/opt/lyrashield-worker-host"
export const CLI_ARGUMENTS = Object.freeze({
  node: ["--version"],
  gh: ["--version"],
  az: ["version", "-o", "json"],
  docker: ["--version"],
  curl: ["--version"],
  systemctl: ["--version"],
  aws: ["--version"],
  unzip: ["-v"],
  pnpm: ["--version"],
})
export function validateRuntimeReadbacks(actual, approved) {
  requireValue(
    approved && Object.keys(approved).sort().join() === Object.keys(CLI_ARGUMENTS).sort().join(),
    "Incomplete approved CLI versions"
  )
  for (const name of Object.keys(CLI_ARGUMENTS))
    requireValue(
      typeof approved[name] === "string" &&
        approved[name].length > 0 &&
        actual[name] === approved[name],
      "Installed CLI version differs: " + name
    )
}
export function probeRootRuntime(policy) {
  loadFixedMigrationEnvironment(policy.databaseIdentitySha256)
  const observed = {}
  for (const [name, args] of Object.entries(CLI_ARGUMENTS)) {
    const binary = realpathSync(`/usr/bin/${name}`)
    checkParents(binary)
    const stat = lstatSync(binary)
    requireValue(
      stat.isFile() && stat.uid === 0 && !(stat.mode & 0o022),
      "Unsafe installed runtime binary"
    )
    const result = spawnSync(`/usr/bin/${name}`, args, {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 65536,
      env: { PATH: "/usr/bin:/bin", HOME: "/root" },
    })
    requireValue(result.status === 0, "Installed CLI unavailable: " + name)
    observed[name] = (result.stdout || result.stderr).trim()
  }
  validateRuntimeReadbacks(observed, policy.cliVersions)
  const code = `import {createRequire} from 'node:module';import {realpathSync,lstatSync,readFileSync,existsSync} from 'node:fs';import {dirname} from 'node:path';
    const root=${JSON.stringify(BUNDLE)},r=createRequire(root+'/packages/db/package.json');
    for(const name of ['pg','pg-connection-string','prisma','dotenv','tsx']) {
      const p=realpathSync(r.resolve(name==='prisma'?'prisma/build/index.js':name));if(!p.startsWith(root+'/'))throw Error('outside bundle');
      for(let d=p;d!=='/';d=dirname(d)){const s=lstatSync(d);if(s.isSymbolicLink()||s.uid!==0||(s.mode&0o022))throw Error('unsafe dependency');}
      let d=dirname(p),meta;while(d.startsWith(root+'/')){const f=d+'/package.json';if(existsSync(f)){const m=JSON.parse(readFileSync(f,'utf8'));if(m.name===name){meta=m;break;}}d=dirname(d);}if(!meta)throw Error('missing package metadata');
      const v=meta.version;if(name==='prisma'&&v!=='7.9.1'||name==='pg-connection-string'&&v!=='2.14.0')throw Error('wrong dependency');
    }
    await import(root+'/packages/db/scripts/webhook-empty-state-migration.mjs');
    await import(root+'/packages/db/prisma.config.ts');
    console.log('EMPTY_STATE_ROOT_RUNTIME_MATCH');`
  const result = spawnSync(
    "/usr/bin/node",
    ["--import", "tsx", "--input-type=module", "-e", code],
    {
      cwd: BUNDLE + "/packages/db",
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 4096,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/root",
        DATABASE_DIRECT_URL: "postgresql://localhost:5432/runtime_probe",
      },
    }
  )
  requireValue(
    result.status === 0 && result.stdout.trim() === "EMPTY_STATE_ROOT_RUNTIME_MATCH",
    "Installed migration dependency/config graph unavailable"
  )
}
