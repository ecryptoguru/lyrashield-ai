import { readInstalledWorkerGrant } from "@lyrashield/db/src/scan-installed-worker-grant-reader"

/** Fixed root image entrypoint; the observer owns policy/role/file authentication. */
async function main() {
  if (process.getuid?.() !== 0 || process.argv.length !== 2)
    throw new Error("Worker observer is unavailable")
  let bytes = Buffer.alloc(0)
  for await (const chunk of process.stdin) {
    bytes = Buffer.concat([bytes, chunk as Buffer])
    if (bytes.length > 4096) throw new Error("Worker observer input exceeds bound")
  }
  const connectionString = process.env.WORKER_OBSERVER_DATABASE_URL
  if (!connectionString) throw new Error("Worker observer connection is unavailable")
  return readInstalledWorkerGrant(connectionString, JSON.parse(bytes.toString("utf8")))
}
main()
  .then((value) => process.stdout.write(`${JSON.stringify(value)}\n`))
  .catch(() => {
    process.stderr.write("Worker authority observation unavailable\n")
    process.exitCode = 1
  })
