import assert from "node:assert/strict"
import test from "node:test"
import { assertExpectedPublisherHold } from "../sandbox-publisher-hold.mjs"
import {
  verifyHeldEnginePublisherRun,
  verifySandboxAttestation,
} from "../paired-runtime-github.mjs"

const source = "a".repeat(40)
const expected = { source, runId: "42", attempt: "1" }
const required = [
  "Assemble and verify qualified platform index",
  "Generate per-platform SPDX SBOMs",
  "Attach and validate complete SBOM artifact",
  "Sign provenance for the immutable image digest",
  "Sign selected runtime and qualified platform binding",
  "Sign per-platform SBOM binding",
  "Verify signed sandbox publication",
  "Qualify bounded SBOM coverage on both native images",
  "Assemble bounded SBOM coverage predicate",
  "Sign bounded SBOM coverage qualification",
  "Verify signed sandbox publication coverage",
  "Upload bounded SBOM coverage evidence",
]
const hold = "Hold promotion pending independent package coverage"
const skipped = ["Promote the smoke-qualified digest", "Record deployable immutable reference"]
function fixture() {
  const step = (name, number, conclusion = "success") => ({
    name,
    number,
    status: "completed",
    conclusion,
  })
  const job = (name) => ({
    name,
    status: "completed",
    conclusion: "success",
    steps: [step("Check source", 1)],
  })
  const steps = [
    ...required.map((name, index) => step(name, index + 1)),
    step(hold, 13, "failure"),
    ...skipped.map((name, index) => step(name, 14 + index, "skipped")),
  ]
  return {
    workflowBlob: { sha: "77361a87c6c7b4e2b11c79a69b9e574fd326a0d0" },
    run: {
      id: 42,
      run_attempt: 1,
      status: "completed",
      conclusion: "failure",
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: source,
      path: ".github/workflows/publish-sandbox.yml",
      repository: { id: 1297157605 },
      head_repository: { id: 1297157605 },
    },
    jobs: {
      total_count: 4,
      jobs: [
        job("Resolve qualified engine revision"),
        job("Build sandbox (amd64)"),
        job("Build sandbox (arm64)"),
        {
          name: "Publish qualified sandbox index",
          status: "completed",
          conclusion: "failure",
          steps,
        },
      ],
    },
  }
}
test("accepts only the exact reviewed intentional publisher hold", () => {
  assert.doesNotThrow(() => assertExpectedPublisherHold(fixture(), expected))
  const mutations = [
    (v) => (v.workflowBlob.sha = "b".repeat(40)),
    (v) => (v.run.head_sha = "b".repeat(40)),
    (v) => (v.run.run_attempt = 2),
    (v) => (v.run.conclusion = "success"),
    (v) => (v.run.head_repository.id = 1),
    (v) => (v.jobs.jobs[1].conclusion = "failure"),
    (v) => (v.jobs.jobs[3].steps[0].conclusion = "failure"),
    (v) => (v.jobs.jobs[3].steps[12].conclusion = "success"),
    (v) => (v.jobs.jobs[3].steps[13].conclusion = "success"),
    (v) => (v.jobs.jobs[3].steps[1].number = 1),
    (v) => (v.jobs.jobs[3].steps[2].name = required[1]),
    (v) => v.jobs.jobs.pop(),
  ]
  for (const mutate of mutations) {
    const value = fixture()
    mutate(value)
    assert.throws(() => assertExpectedPublisherHold(value, expected))
  }
})

test("reads the exact run, attempt, workflow blob and current main ancestry", () => {
  const value = fixture()
  const responses = new Map([
    ["actions/runs/42/attempts/1", value.run],
    ["actions/runs/42/attempts/1/jobs?per_page=100", value.jobs],
    ["contents/.github/workflows/publish-sandbox.yml?ref=" + source, value.workflowBlob],
    ["compare/" + source + "...main", { merge_base_commit: { sha: source }, status: "ahead" }],
  ])
  const read = (path) => {
    assert.ok(responses.has(path))
    return responses.get(path)
  }
  assert.doesNotThrow(() => verifyHeldEnginePublisherRun("42", "1", source, read))
  responses.set("compare/" + source + "...main", {
    merge_base_commit: { sha: "b".repeat(40) },
    status: "ahead",
  })
  assert.throws(() => verifyHeldEnginePublisherRun("42", "1", source, read))
})

test("paired reader retrieves the attestation from the OCI registry", () => {
  const response = [
    {
      verificationResult: {
        statement: {
          predicateType: "https://slsa.dev/provenance/v1",
          subject: [{ digest: { sha256: "c".repeat(64) } }],
          predicate: {
            runDetails: {
              metadata: {
                invocationId:
                  "https://github.com/ecryptoguru/lyrashield-engine/actions/runs/42/attempts/1",
              },
            },
          },
        },
      },
    },
  ]
  assert.doesNotThrow(() =>
    verifySandboxAttestation(
      { sandboxDigest: "sha256:" + "c".repeat(64), engineRevision: source },
      "42",
      "1",
      {
        run: (args) => {
          assert.ok(args.includes("--bundle-from-oci"))
          return JSON.stringify(response)
        },
      }
    )
  )
})
