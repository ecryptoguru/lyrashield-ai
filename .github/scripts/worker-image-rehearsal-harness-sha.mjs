import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

// These files define the exact-image worker rehearsal. Keep this list narrow
// and update it whenever the reusable workflow gains another executable input.
export const WORKER_IMAGE_REHEARSAL_HARNESS_FILES = [
  ".github/scripts/run-cold-engine-native-probes.py",
  ".github/scripts/cold-engine-native-probe.py",
  ".github/scripts/cold-sandbox-native-probe.py",
  ".github/scripts/run-cold-paid-claim-image-probe.sh",
  ".github/scripts/cold-paid-claim-image-probe.mjs",
  ".github/scripts/tests/worker-auto-recovery.postgres.mjs",
  ".github/scripts/tests/worker-recovery.systemd.mjs",
  ".github/scripts/verify-cold-sandbox.mjs",
  ".github/cold-sandbox-publication.json",
  ".github/scripts/run-engine-physical-ceiling-drill.py",
  ".github/scripts/cold-database-epoch-image-probe.mjs",
  ".github/scripts/disposable-worker-rehearsal-role.sql",
  ".github/scripts/fixtures/worker-evidence-distinct/receipt.json",
  ".github/scripts/fixtures/worker-evidence-distinct/run.json",
  ".github/scripts/fixtures/worker-evidence-distinct/vulnerabilities.json",
  ".github/scripts/fixtures/worker-evidence-distinct/http_exchanges.json",
  ".github/scripts/normalize-worker-image-reference.sh",
  ".github/scripts/run-worker-evidence-persistence-drill.sh",
  ".github/scripts/worker-evidence-persistence-drill.mjs",
  ".github/scripts/worker-evidence-drill-oracle.mjs",
  ".github/scripts/worker-evidence-drill-selection.mjs",
  ".github/scripts/worker-evidence-fixture-io.py",
  ".github/scripts/worker-evidence-drill-guard.py",
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
    // A pinned file deleted in the working tree is recorded as absent rather
    // than crashing the release gate; every file that is present is still
    // hashed in full, so an active pin can never be silently dropped.
    const contents = readPinnedFile(path.join(repositoryRoot, file))
    hash.update(file)
    hash.update("\0")
    hash.update(contents === undefined ? "absent" : String(contents.length))
    hash.update("\0")
    if (contents !== undefined) hash.update(contents)
    hash.update("\0")
  }
  return `sha256:${hash.digest("hex")}`
}

function readPinnedFile(file) {
  try {
    if (!statSync(file).isFile()) return undefined
    return readFileSync(file)
  } catch {
    return undefined
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) {
    throw new Error("Usage: node worker-image-rehearsal-harness-sha.mjs")
  }
  console.log(workerImageRehearsalHarnessSha())
}
