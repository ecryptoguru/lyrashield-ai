import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

// Privileged workflow_dispatch jobs must never execute code from an
// unreviewed ref: a dispatch on an arbitrary branch would otherwise run its
// checkout (dependencies, scripts, application code) while holding
// production secrets. Every secret-bearing or publish job below is either
// gated to refs/heads/main or proven to run no repository code at all.

const read = (name) => readFileSync(`.github/workflows/${name}`, "utf8")

const jobSection = (source, name) => {
  const section = source.split(`\n  ${name}:\n`)[1]?.split(/\n  [a-z][\w-]*:/)[0]
  assert.ok(section, `expected job ${name}`)
  return section
}

test("platform admin provisioning only runs on reviewed main", () => {
  const workflow = read("provision-platform-admins.yml")
  const job = jobSection(workflow, "provision")
  // The job installs dependencies and runs the provisioning command with the
  // production database credential; the dispatch ref must be main.
  assert.match(job, /^    if: github\.ref == 'refs\/heads\/main'$/m)
  // The static confirmation gate still precedes any checkout or credential use.
  const confirm = job.indexOf("- name: Validate explicit confirmation")
  const checkout = job.indexOf("uses: actions/checkout@")
  assert.ok(confirm !== -1 && checkout !== -1)
  assert.ok(confirm < checkout, "confirmation must be validated before checkout")
})

test("backup jobs hold production secrets only on reviewed main", () => {
  const workflow = read("production-backup.yml")
  const backup = jobSection(workflow, "backup")
  const restore = jobSection(workflow, "restore")
  // Ordinary backups run no repository code. The opt-in private manual mode
  // checks out only the source guarded before any credential-bearing step.
  assert.match(backup, /^    if: github\.ref == 'refs\/heads\/main'$/m)
  assert.match(
    backup,
    /name: Checkout isolated restore helpers\n        if: inputs\.isolated_restore\n        uses: actions\/checkout@/
  )
  assert.match(backup, /ref: \$\{\{ github\.sha \}\}/)
  assert.ok(
    backup.indexOf("Bind isolated restore to the reviewed source") <
      backup.indexOf("uses: actions/checkout@")
  )
  assert.ok(backup.indexOf("uses: actions/checkout@") < backup.indexOf("secrets."))
  // The restore drill does check out the repository and run install/app code
  // with backup credentials, so dispatch is restricted to main.
  assert.match(restore, /github\.ref == 'refs\/heads\/main'/)
  assert.match(restore, /github\.event\.schedule == '0 2 \* \* 0'/)
  assert.match(restore, /uses: actions\/checkout@/)
})

test("billing admission executes reviewed main tooling against a reviewed target", () => {
  const workflow = read("configure-cloud-billing-admission.yml")
  const job = jobSection(workflow, "configure")
  assert.match(job, /^    if: github\.ref == 'refs\/heads\/main'$/m)
  // Scripts come from the reviewed main checkout, never the input SHA, and
  // the input must equal that reviewed head before any script runs.
  const checkout = job.indexOf("uses: actions/checkout@")
  const guard = job.indexOf("Restrict the deploy target to the reviewed main head")
  const script = job.indexOf("configure-cloud-billing-admission.sh")
  assert.ok(checkout !== -1 && guard !== -1 && script !== -1)
  assert.ok(checkout < guard && guard < script)
  assert.match(job, /ref: main/)
  assert.doesNotMatch(job, /ref: \$\{\{ inputs\.source_sha \}\}/)
  assert.match(job, /\[ "\$SOURCE_SHA" != "\$\(git rev-parse HEAD\)" \]/)
})

test("desktop release jobs cannot sign or publish unmerged tag commits", () => {
  const workflow = read("release-tauri.yml")
  const preflight = jobSection(workflow, "preflight")
  // The tag is already required to be a pushed v* tag pointing at the
  // checkout; it must additionally wrap code merged into main so a tag on an
  // unreviewed commit cannot reach the signing environments.
  const compare = preflight.indexOf("compare/main...")
  assert.ok(compare !== -1, "preflight must compare the tag against main")
  assert.match(preflight, /behind\|identical/)
  const verify = preflight.indexOf("- name: Verify credentials, tag, and version")
  assert.ok(verify !== -1 && verify < compare, "tag shape must validate before the merge check")
  assert.match(workflow, /needs: preflight/)
  assert.match(workflow, /needs: \[macos, windows\]/)
})

test("release routing reads artifacts without inheriting package write", () => {
  const workflow = read("release-production.yml")
  const routing = jobSection(workflow, "routing")
  // The routing job only downloads the CI artifact and reads the main ref;
  // packages: write is reserved for the reusable deploy job.
  assert.match(routing, /^    permissions:\n      actions: read\n      contents: read$/m)
  assert.doesNotMatch(routing, /packages: write/)
})

test("scan and readiness workflows carry no unreviewed-code execution surface", () => {
  // No checkout and no secrets: a dispatched ref can only run the in-file
  // probe, and contents:read is the whole token scope.
  const readiness = read("production-scan-readiness.yml")
  assert.doesNotMatch(readiness, /uses: actions\/checkout@/)
  assert.doesNotMatch(readiness, /secrets\./)
  assert.match(readiness, /^permissions:\n  contents: read$/m)

  // The diff gate checks out PR code only to read it — scanners run pinned
  // installs and never execute repository code. pull_request (not
  // pull_request_target) keeps fork code out of a privileged context.
  const scan = read("lyrashield-scan.yml")
  assert.doesNotMatch(scan, /pull_request_target/)
  assert.doesNotMatch(scan, /pnpm install|npm ci|pnpm db:generate/)
})
