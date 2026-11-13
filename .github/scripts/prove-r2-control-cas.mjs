// Explicit disposable transport qualification only; never creates production pin authority.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { createRequire } from "node:module"
const require = createRequire(
  new URL("../../packages/runtime-control/package.json", import.meta.url)
)
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3")
function secret(name, vault = "lyrashieldprodsecrets") {
  // Values remain in this process; Azure/provider diagnostics never reach logs.
  try {
    return execFileSync(
      "az",
      [
        "keyvault",
        "secret",
        "show",
        "--vault-name",
        vault,
        "--name",
        name,
        "--query",
        "value",
        "--output",
        "tsv",
        "--only-show-errors",
      ],
      { timeout: 30_000, maxBuffer: 8192, stdio: ["ignore", "pipe", "pipe"] }
    )
      .toString("utf8")
      .trim()
  } catch {
    throw new Error("Disposable R2 transport credentials unavailable")
  }
}
const controlMode = process.argv.length === 3 && process.argv[2] === "--control"
assert.ok(process.argv.length === 2 || controlMode)
const control = controlMode
  ? JSON.parse(secret("runtime-control-r2-storage", "lyrashieldqualb2f8f58b"))
  : null
if (control) {
  assert.deepEqual(
    Object.keys(control).sort(),
    ["schema", "accountId", "bucket", "accessKeyId", "secretAccessKey"].sort()
  )
  assert.equal(control.schema, "lyrashield-root-control-r2-storage/1")
  assert.equal(control.bucket, "lyrashield-runtime-control")
  assert.match(control.accountId, /^[a-f0-9]{32}$/)
  assert.match(control.accessKeyId, /^[a-f0-9]{32}$/)
  assert.match(control.secretAccessKey, /^[a-f0-9]{64}$/)
}
const bucket = control?.bucket ?? secret("worker-r2-bucket")
const endpoint = control
  ? `https://${control.accountId}.r2.cloudflarestorage.com`
  : secret("worker-r2-endpoint")
assert.equal(bucket, controlMode ? "lyrashield-runtime-control" : "lyrashield-production-evidence")
assert.match(endpoint, /^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com\/?$/)
const client = new S3Client({
  region: "auto",
  endpoint,
  maxAttempts: 1,
  credentials: {
    accessKeyId: control?.accessKeyId ?? secret("worker-r2-access-key"),
    secretAccessKey: control?.secretAccessKey ?? secret("worker-r2-secret-key"),
  },
})
const prefix = "runtime-control-transport-proof/" + randomUUID()
const key = prefix + "/current"
const bytes = (revision, parent) =>
  Buffer.from(
    JSON.stringify({ schema: "lyrashield-disposable-cas-proof/1", revision, parent, prefix })
  )
const hash = (body) => createHash("sha256").update(body).digest("hex")
const put = (body, condition) =>
  client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ...condition }))
async function read() {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  return { bytes: Buffer.from(await result.Body.transformToByteArray()), etag: result.ETag }
}
try {
  if (controlMode) {
    await assert.rejects(
      client.send(
        new GetObjectCommand({ Bucket: "lyrashield-authority-journal", Key: prefix + "/absent" })
      ),
      (error) => error?.$metadata?.httpStatusCode === 403
    )
    process.stdout.write("Control credential denied journal bucket access.\n")
  }
  const original = bytes(1, null)
  await put(original, { IfNoneMatch: "*" })
  const first = await read()
  assert.deepEqual(first.bytes, original)
  const siblings = [bytes(2, hash(original)), bytes(3, hash(original))]
  const races = await Promise.allSettled(siblings.map((body) => put(body, { IfMatch: first.etag })))
  assert.equal(races.filter((x) => x.status === "fulfilled").length, 1)
  assert.equal(
    races.filter((x) => x.status === "rejected" && x.reason?.$metadata?.httpStatusCode === 412)
      .length,
    1
  )
  const committed = await read()
  assert.ok(siblings.some((body) => body.equals(committed.bytes)))
  await assert.rejects(
    put(original, { IfMatch: first.etag }),
    (error) => error?.$metadata?.httpStatusCode === 412
  )
  // Fault injection discards the response after a genuine remote commit; a read
  // of that original body is the only acknowledgement accepted by this proof.
  const retryBody = bytes(4, hash(committed.bytes))
  await assert.rejects(
    (async () => {
      await put(retryBody, { IfMatch: committed.etag })
      throw new Error("response lost after remote commit")
    })()
  )
  const recovered = await read()
  assert.deepEqual(recovered.bytes, retryBody)
  await assert.rejects(
    put(retryBody, { IfMatch: committed.etag }),
    (error) => error?.$metadata?.httpStatusCode === 412
  )
  const newer = bytes(5, hash(retryBody))
  await put(newer, { IfMatch: recovered.etag })
  assert.notEqual(hash((await read()).bytes), hash(retryBody))
  process.stdout.write(
    "Actual R2 CAS: one concurrent winner; stale restore rejected; original lost-response readback retained; newer state differs.\n"
  )
} finally {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
  await assert.rejects(read(), (error) => error?.$metadata?.httpStatusCode === 404)
  client.destroy()
  process.stdout.write(
    "Owned disposable R2 proof object removed. No production control authority created.\n"
  )
}
