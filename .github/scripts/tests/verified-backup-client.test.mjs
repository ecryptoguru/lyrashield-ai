import test from "node:test"
import assert from "node:assert/strict"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  realpathSync,
  readdirSync,
  statSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { createHash, X509Certificate } from "node:crypto"
import {
  prepareVerifiedBackupConnection,
  verifiedBackupRootCaContainerPath,
} from "../prepare-verified-backup-connection.mjs"

const repository = fileURLToPath(new URL("../../../", import.meta.url))
const workflow = readFileSync(
  new URL("../../workflows/production-backup.yml", import.meta.url),
  "utf8"
)
const start = workflow.indexOf("      - name: Create, encrypt, and upload backup\n")
assert.notEqual(start, -1)
const step = workflow.slice(start, workflow.indexOf("\n      - name:", start + 1))
const shell = step
  .split("        run: |\n")[1]
  .split("\n")
  .filter((line) => line.startsWith("          "))
  .map((line) => line.slice(10))
  .join("\n")
const direct =
  "postgresql://postgres:synthetic-only@db.localprojectfixture1.supabase.co:5432/postgres?schema=public&sslmode=require&uselibpqcompat=1"
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")
const rootCaPath = join(repository, ".github/certs/supabase-root-2021-ca.crt")
const expectedRootCaFingerprint = "807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa"

test("backup trust anchor is a self-signed CA matching the reviewed certificate fingerprint", () => {
  const certificate = new X509Certificate(readFileSync(rootCaPath))
  assert.equal(certificate.ca, true)
  assert.equal(certificate.subject, certificate.issuer)
  assert.equal(certificate.verify(certificate.publicKey), true)
  assert.ok(Date.parse(certificate.validFrom) <= Date.now())
  assert.ok(Date.parse(certificate.validTo) > Date.now())
  assert.equal(
    certificate.fingerprint256.replaceAll(":", "").toLowerCase(),
    expectedRootCaFingerprint
  )
  assert.equal(verifiedBackupRootCaContainerPath(rootCaPath), "/tmp/supabase-root-2021-ca.crt")
})

test("backup trust-anchor validation rejects missing, malformed, replaced and appended CA files", (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "backup-root-ca-validation-")))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const keyPath = join(directory, "untrusted-root.key")
  const certificatePath = join(directory, "untrusted-root.crt")
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
      "-days",
      "2",
      "-subj",
      "/CN=Untrusted Fixture Root",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ],
    { encoding: "utf8" }
  )
  assert.equal(generated.status, 0, generated.stderr)
  const otherRoot = readFileSync(certificatePath)
  assert.equal(new X509Certificate(otherRoot).ca, true)

  assert.throws(
    () => verifiedBackupRootCaContainerPath(join(directory, "missing.crt")),
    /unavailable or invalid/
  )

  const malformedPath = join(directory, "malformed.crt")
  writeFileSync(malformedPath, "not a certificate")
  assert.throws(() => verifiedBackupRootCaContainerPath(malformedPath), /unavailable or invalid/)

  assert.throws(
    () => verifiedBackupRootCaContainerPath(certificatePath),
    /does not match the reviewed Supabase root/
  )

  const appendedPath = join(directory, "appended.crt")
  writeFileSync(appendedPath, Buffer.concat([readFileSync(rootCaPath), otherRoot]))
  assert.throws(
    () => verifiedBackupRootCaContainerPath(appendedPath),
    /file does not match the reviewed certificate/
  )
})

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "verified-backup-client-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, "bin"),
    runner = join(root, "runner"),
    calls = join(root, "calls")
  mkdirSync(bin)
  mkdirSync(runner)
  writeFileSync(calls, "")
  const executable = (name, body) =>
    writeFileSync(join(bin, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 })
  executable(
    "stat",
    `const fs=require('node:fs'),s=fs.statSync(process.argv[4]);console.log(process.argv[3]==='%u'?s.uid:(s.mode&511).toString(8));`
  )
  executable(
    "docker",
    `
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
const {X509Certificate}=require('node:crypto');
assert.equal(fs.fstatSync(2).mode&511,384);
fs.appendFileSync(process.env.MOCK_CALLS,'docker\\n');
const mount=args[args.indexOf('--mount')+1];
assert.equal(mount,'type=bind,source='+process.env.EXPECTED_ROOT_CA_PATH+',target=/tmp/supabase-root-2021-ca.crt,readonly');
const ca=new X509Certificate(fs.readFileSync(process.env.EXPECTED_ROOT_CA_PATH));
assert.equal(ca.fingerprint256.replaceAll(':','').toLowerCase(),process.env.EXPECTED_ROOT_CA_FINGERPRINT);
const url=new URL(args[args.indexOf('--env')+1].slice('PG_URL='.length));
assert.equal(url.href,process.env.EXPECTED_LIBPQ_URL);
assert.equal(url.searchParams.get('sslmode'),'verify-full');
assert.equal(url.searchParams.get('sslrootcert'),'/tmp/supabase-root-2021-ca.crt');
assert.equal(url.searchParams.get('gssencmode'),'disable');
assert.equal(url.searchParams.has('uselibpqcompat'),false);
assert.equal(url.searchParams.has('schema'),false);
assert.ok(args.includes('postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73'));
assert.ok(args.at(-1).includes('--schema=public --schema=app'));
if(process.env.MOCK_CLIENT_ERROR){console.error(process.env.MOCK_CLIENT_ERROR);process.exit(42)}
const name=args.at(-1).split('--file="/backup/')[1].split('"')[0];
fs.writeFileSync(path.join(process.env.RUNNER_TEMP,name),'SYNTHETIC_DUMP');
`
  )
  executable(
    "gpg",
    `const fs=require('node:fs'),args=process.argv.slice(2);fs.readFileSync(0);fs.appendFileSync(process.env.MOCK_CALLS,'gpg\\n');fs.writeFileSync(args[args.indexOf('--output')+1],'SYNTHETIC_CIPHER');`
  )
  executable(
    "sha256sum",
    `const fs=require('node:fs'),crypto=require('node:crypto');console.log(crypto.createHash('sha256').update(fs.readFileSync(process.argv[2])).digest('hex')+'  '+process.argv[2]);`
  )
  executable(
    "aws",
    `const fs=require('node:fs'),args=process.argv.slice(2);fs.appendFileSync(process.env.MOCK_CALLS,'aws '+args[0]+' '+args[1]+'\\n');if(args[args.indexOf('--query')+1]==='Metadata.sha256')console.log(process.env.EXPECTED_DUMP_SHA256);else if(args[args.indexOf('--query')+1]==='ETag')console.log('"abc123"');`
  )
  return {
    root,
    calls,
    runner,
    run: (extra) => {
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: runner,
        ISOLATED_RESTORE: "false",
        GITHUB_RUN_ID: "1234",
        GITHUB_WORKSPACE: repository,
        GITHUB_OUTPUT: join(root, "output"),
        GITHUB_ENV: join(root, "github-env"),
        DATABASE_DIRECT_URL: direct,
        BACKUP_ENCRYPTION_PASSPHRASE: "SYNTHETIC_ONLY",
        R2_BACKUP_BUCKET: "synthetic",
        R2_S3_ENDPOINT: "https://synthetic.invalid",
        MOCK_CALLS: calls,
        EXPECTED_DUMP_SHA256: digest("SYNTHETIC_DUMP"),
        EXPECTED_ROOT_CA_PATH: rootCaPath,
        EXPECTED_ROOT_CA_FINGERPRINT: expectedRootCaFingerprint,
        EXPECTED_LIBPQ_URL: prepareVerifiedBackupConnection(direct).libpqUrl,
        ...extra,
      }
      let privateDirectory
      if (env.ISOLATED_RESTORE === "true") {
        const prepared = spawnSync(
          "bash",
          [".github/scripts/isolated-restore-private.sh", "prepare"],
          { cwd: repository, env, encoding: "utf8" }
        )
        assert.equal(prepared.status, 0, prepared.stderr)
        privateDirectory = readFileSync(env.GITHUB_ENV, "utf8").trim().split("=")[1]
        env.ISOLATED_RESTORE_TEMP = privateDirectory
      }
      const result = spawnSync("bash", ["-c", shell], {
        cwd: repository,
        encoding: "utf8",
        timeout: 10000,
        env,
      })
      return { ...result, privateDirectory }
    },
  }
}

test("actual backup block connects with verified TLS before publishing identity and exact-object digests", (t) => {
  const f = fixture(t),
    result = f.run({})
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, "")
  assert.equal(
    readFileSync(f.calls, "utf8"),
    "docker\ngpg\naws s3 cp\naws s3api head-object\naws s3api head-object\n"
  )
  const output = readFileSync(join(f.root, "output"), "utf8")
  assert.match(
    output,
    new RegExp(
      `database_identity_sha256=${prepareVerifiedBackupConnection(direct).identitySha256}\\n`
    )
  )
  assert.match(output, new RegExp(`dump_sha256=${digest("SYNTHETIC_DUMP")}\\n`))
  assert.match(output, new RegExp(`encrypted_sha256=${digest("SYNTHETIC_CIPHER")}\\n`))
  assert.match(output, /object_etag="abc123"\n/)
  for (const value of [
    "postgresql:",
    "synthetic-only",
    "localprojectfixture1",
    "sslmode",
    "uselibpqcompat",
  ])
    assert.equal(output.includes(value), false)
  assert.equal(readFileSync(f.calls, "utf8").includes("sslmode"), false)
})

for (const raw of [
  direct + "&host=untrusted.invalid",
  direct + "&%73slmode=require",
  direct.replace("uselibpqcompat=1", "uselibpqcompat=false"),
  direct.replace("sslmode=require", "sslmode=disable"),
])
  test("actual backup block rejects unsafe connection input before dump, upload or producer output", (t) => {
    const f = fixture(t),
      result = f.run({ DATABASE_DIRECT_URL: raw })
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, "")
    assert.equal(result.stderr, "Verified backup connection preparation failed.\n")
    assert.equal(readFileSync(f.calls, "utf8"), "")
    assert.throws(() => readFileSync(join(f.root, "output")), /ENOENT/)
  })

for (const [message, reason] of [
  ["certificate verify failed", "certificate-untrusted"],
  ["does not match host name", "hostname-mismatch"],
  ["server does not support SSL", "tls-unavailable"],
  ["unclassified private error", "connection-or-dump-failed"],
])
  for (const isolated of ["false", "true"]) {
    test(`actual backup block safely reports ${reason} in isolated=${isolated} before upload/proof`, (t) => {
      const f = fixture(t),
        raw = `${message}: postgresql://private-value.invalid fixture-password private-row-context`
      const result = f.run({ MOCK_CLIENT_ERROR: raw, ISOLATED_RESTORE: isolated })
      assert.equal(result.status, 42)
      assert.equal(result.stdout, `Backup failed (verified-client/${reason}).\n`)
      assert.equal(result.stderr, "")
      assert.equal(readFileSync(f.calls, "utf8"), "docker\n")
      assert.throws(() => readFileSync(join(f.root, "output")), /ENOENT/)
      const directory = result.privateDirectory ?? f.runner
      assert.equal(
        readdirSync(directory).some((name) => name.startsWith("backup-client.")),
        false
      )
      if (result.privateDirectory) {
        const log = join(directory, "private-operation.log")
        assert.equal(readFileSync(log, "utf8"), raw + "\n")
        assert.equal(statSync(log).mode & 0o777, 0o600)
      }
    })
  }

test("backup helpers are checked out at the reviewed SHA and dependencies install without production secrets or scripts", () => {
  const setup = workflow.slice(
    workflow.indexOf("      - name: Checkout reviewed backup helpers"),
    workflow.indexOf("      - name: Prepare private isolated backup files")
  )
  assert.match(setup, /ref: \$\{\{ github.sha \}\}/)
  assert.match(setup, /persist-credentials: false/)
  assert.match(setup, /pnpm install --frozen-lockfile --ignore-scripts/)
  assert.doesNotMatch(setup, /secrets\.|\n        env:|\n        if:/)
})
