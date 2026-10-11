import assert from "node:assert/strict"
import test from "node:test"
import { assertNoPriorRuntimePromotion } from "../assert-no-prior-runtime-promotion.mjs"

const context = {
  repository: "example/lyrashield-ai",
  runId: "12345",
  attempt: 2,
}

const skippedRuntime = {
  jobs: [{ name: "Deploy Azure Container Apps", status: "completed", conclusion: "skipped" }],
}

test("allows a retry after the earlier runtime job was explicitly skipped", () => {
  assert.doesNotThrow(() =>
    assertNoPriorRuntimePromotion({
      ...context,
      getAttemptJobs: () => skippedRuntime,
    })
  )
})

test("allows a completed runtime attempt only when healthy-revision promotion was skipped", () => {
  assert.doesNotThrow(() =>
    assertNoPriorRuntimePromotion({
      ...context,
      getAttemptJobs: () => ({
        jobs: [
          {
            name: "Deploy Azure Container Apps",
            status: "completed",
            conclusion: "failure",
            steps: [
              {
                name: "Promote healthy candidate revisions",
                status: "completed",
                conclusion: "skipped",
              },
            ],
          },
        ],
      }),
    })
  )
})

test("ignores reusable-workflow dependency jobs when checking the runtime promotion step", () => {
  assert.doesNotThrow(() =>
    assertNoPriorRuntimePromotion({
      ...context,
      getAttemptJobs: () => ({
        jobs: [
          {
            name: "deploy-azure / Deploy Azure Container Apps / Prepare migration dependencies without production credentials",
            status: "completed",
            conclusion: "success",
            steps: [],
          },
          {
            name: "deploy-azure / Deploy Azure Container Apps / Deploy Azure Container Apps",
            status: "completed",
            conclusion: "cancelled",
            steps: [
              {
                name: "Promote healthy candidate revisions",
                status: "completed",
                conclusion: "skipped",
              },
            ],
          },
        ],
      }),
    })
  )

  assert.throws(
    () =>
      assertNoPriorRuntimePromotion({
        ...context,
        getAttemptJobs: () => ({
          jobs: [
            {
              name: "deploy-azure / Deploy Azure Container Apps / Prepare migration dependencies without production credentials",
              status: "completed",
              conclusion: "success",
              steps: [],
            },
          ],
        }),
      }),
    /no verifiable Azure runtime job record/
  )

  assert.throws(
    () =>
      assertNoPriorRuntimePromotion({
        ...context,
        getAttemptJobs: () => ({
          jobs: [
            {
              name: "deploy-azure / Post-deployment verification",
              status: "completed",
              conclusion: "success",
              steps: [
                {
                  name: "Promote healthy candidate revisions",
                  status: "completed",
                  conclusion: "skipped",
                },
              ],
            },
          ],
        }),
      }),
    /no verifiable Azure runtime job record/
  )
})

test("refuses a retry when an earlier promotion started, even if it failed", () => {
  for (const conclusion of ["success", "failure", "cancelled"]) {
    assert.throws(
      () =>
        assertNoPriorRuntimePromotion({
          ...context,
          getAttemptJobs: () => ({
            jobs: [
              {
                name: "Deploy Azure Container Apps",
                status: "completed",
                conclusion: "failure",
                steps: [
                  {
                    name: "Promote healthy candidate revisions",
                    status: "completed",
                    conclusion,
                  },
                ],
              },
            ],
          }),
        }),
      /rollback baseline may have changed/
    )
  }
})

test("fails closed when an attempted runtime job has missing or unfinished promotion evidence", () => {
  const cases = [
    { jobs: [] },
    { jobs: [{ name: "Deploy Azure Container Apps", status: "in_progress", conclusion: null }] },
    {
      jobs: [
        {
          name: "Deploy Azure Container Apps",
          status: "completed",
          conclusion: "failure",
          steps: [],
        },
      ],
    },
  ]
  for (const response of cases) {
    assert.throws(() =>
      assertNoPriorRuntimePromotion({ ...context, getAttemptJobs: () => response })
    )
  }
})

test("checks every earlier attempt and performs no API read on the first attempt", () => {
  const seen = []
  assertNoPriorRuntimePromotion({
    ...context,
    attempt: 3,
    getAttemptJobs: (_repo, _run, number) => {
      seen.push(number)
      return skippedRuntime
    },
  })
  assert.deepEqual(seen, [1, 2])
  assert.doesNotThrow(() =>
    assertNoPriorRuntimePromotion({
      ...context,
      attempt: 1,
      getAttemptJobs: () => assert.fail("first attempts do not query GitHub"),
    })
  )
})

test("propagates unreadable attempt data as a closed failure", () => {
  assert.throws(
    () =>
      assertNoPriorRuntimePromotion({
        ...context,
        getAttemptJobs: () => {
          throw new Error("GitHub API unavailable")
        },
      }),
    /GitHub API unavailable/
  )
})
