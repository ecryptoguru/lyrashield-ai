import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

// These files define the exact-image worker rehearsal. Keep this list narrow
// and update it whenever the reusable workflow gains another executable input.
export const WORKER_IMAGE_REHEARSAL_HARNESS_FILES = [
  ".github/scripts/normalize-worker-image-reference.sh",
  ".github/scripts/tests/supabase-db-tls.docker.mjs",
  ".github/scripts/tests/webhook-cutover-release.redis.test.mjs",
  ".github/scripts/tests/webhook-cutover-schema.postgres.test.mjs",
  ".github/scripts/webhook-track-image-smoke.mjs",
  ".github/scripts/worker-image-rehearsal-harness-sha.mjs",
  ".github/workflows/verify-webhook-worker-image.yml",
  "apps/worker/scripts/verify-worker-image.sh",
].sort()

export function workerImageRehearsalHarnessSha(repositoryRoot = process.cwd()) {
  const hash = createHash("sha256")
  for (const file of WORKER_IMAGE_REHEARSAL_HARNESS_FILES) {
    const contents = readFileSync(path.join(repositoryRoot, file))
    hash.update(file)
    hash.update("\0")
    hash.update(String(contents.length))
    hash.update("\0")
    hash.update(contents)
    hash.update("\0")
  }
  return `sha256:${hash.digest("hex")}`
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) {
    throw new Error("Usage: node worker-image-rehearsal-harness-sha.mjs")
  }
  console.log(workerImageRehearsalHarnessSha())
}
