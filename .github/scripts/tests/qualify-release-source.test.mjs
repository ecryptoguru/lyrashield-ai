import assert from "node:assert/strict"
import test from "node:test"
import { qualifyReleaseSource } from "../qualify-release-source.mjs"

const repository = "ecryptoguru/lyrashield-ai"
const root = `repos/${repository}`
const sha = "a".repeat(40)
const base = "b".repeat(40)
const head = "c".repeat(40)
const syntheticSha = "d".repeat(40)
const tree = "e".repeat(40)
const other = "f".repeat(40)
const names = [
  "SCA & Secret Scan",
  "Lint, Typecheck, Test & Build",
  "Pinned Engine / Worker Contract",
]
const success = { status: "completed", conclusion: "success" }

function fixture(mapping = "merge") {
  const job = (name, id) => ({
    name,
    id,
    run_id: 20,
    head_sha: head,
    ...success,
    check_run_url: `https://api.github.com/${root}/check-runs/${id + 100}`,
  })
  const pr = {
    number: 1048,
    merged: true,
    merge_commit_sha: sha,
    base: { ref: "main", sha: base, repo: { full_name: repository } },
    head: { sha: head, repo: { full_name: repository } },
  }
  const run = {
    id: 20,
    workflow_id: 30,
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    head_sha: head,
    run_attempt: 1,
    check_suite_id: 40,
    ...success,
    pull_requests: [],
  }
  const jobs = [
    job(
      `Detect changed paths [source: pr=1048 base=${base} head=${head} merge=${syntheticSha}]`,
      50
    ),
    ...names.map((name, index) => job(name, 51 + index)),
  ]
  const pages = (items, key) => (key ? { total_count: items.length, [key]: items } : items)
  const responses = new Map([
    [`${root}/git/ref/heads/main`, { object: { sha } }],
    [`${root}/commits/${sha}/pulls?per_page=100&page=1`, [pr]],
    [`${root}/pulls/1048`, pr],
    [
      `${root}/git/commits/${sha}`,
      {
        sha,
        tree: { sha: tree },
        parents: (mapping === "merge" ? [base, head] : [base]).map((sha) => ({ sha })),
      },
    ],
    [
      `${root}/git/commits/${syntheticSha}`,
      { sha: syntheticSha, tree: { sha: tree }, parents: [base, head].map((sha) => ({ sha })) },
    ],
    [`${root}/actions/workflows/ci.yml`, { id: 30, path: ".github/workflows/ci.yml" }],
    [
      `${root}/actions/workflows/30/runs?event=pull_request&head_sha=${head}&per_page=100&page=1`,
      pages([run], "workflow_runs"),
    ],
    [`${root}/actions/runs/20`, run],
    [`${root}/actions/runs/20/attempts/1/jobs?per_page=100&page=1`, pages(jobs, "jobs")],
    ...jobs.slice(1).map((job) => [
      `${root}/check-runs/${job.id + 100}`,
      {
        id: job.id + 100,
        name: job.name,
        head_sha: head,
        ...success,
        details_url: `https://github.com/${repository}/actions/runs/20/job/${job.id}`,
        app: { id: 15368, slug: "github-actions" },
        check_suite: { id: 40 },
      },
    ]),
  ])
  const calls = []
  const api = (endpoint) => {
    calls.push(endpoint)
    assert.ok(responses.has(endpoint), `Unexpected API call: ${endpoint}`)
    const result = responses.get(endpoint)
    if (result instanceof Error) throw result
    if (typeof result === "function") return result()
    return structuredClone(result)
  }
  return {
    responses,
    run,
    pr,
    jobs,
    calls,
    qualify: () => qualifyReleaseSource({ repository, sha, api }),
  }
}

for (const mapping of ["merge", "squash"]) {
  test(`qualifies exact ${mapping} source from genuine CI, without mutable run PR metadata`, () => {
    const f = fixture(mapping)
    assert.deepEqual(f.qualify(), { sha, pr: 1048, runId: 20, attempt: 1, syntheticSha, mapping })
  })
}

const rejectionCases = {
  "pending run": (f) => {
    f.run.status = "in_progress"
    f.run.conclusion = null
  },
  "failed run": (f) => {
    f.run.conclusion = "failure"
    f.jobs[1].conclusion = "failure"
  },
  "cancelled run": (f) => {
    f.run.conclusion = "cancelled"
  },
  "missing required job": (f) => {
    f.jobs.pop()
    f.responses.get(`${root}/actions/runs/20/attempts/1/jobs?per_page=100&page=1`).total_count--
  },
  "pending required job": (f) => {
    f.jobs[1].status = "queued"
  },
  "failed required job": (f) => {
    f.jobs[1].conclusion = "failure"
  },
  "skipped required job": (f) => {
    f.jobs[1].conclusion = "skipped"
  },
  "ambiguous required job": (f) => {
    f.jobs[2].name = f.jobs[1].name
  },
  "stale event head": (f) => {
    f.jobs[0].name = f.jobs[0].name.replace(`head=${head}`, `head=${other}`)
  },
  "stale event base": (f) => {
    f.jobs[0].name = f.jobs[0].name.replace(`base=${base}`, `base=${other}`)
  },
  "another PR receipt replay": (f) => {
    f.jobs[0].name = f.jobs[0].name.replace("pr=1048", "pr=1047")
  },
  "missing immutable receipt": (f) => {
    f.jobs[0].name = "Detect changed paths"
  },
  "stale PR head": (f) => {
    f.pr.head.sha = other
  },
  "stale PR base": (f) => {
    f.pr.base.sha = other
  },
  "wrong merge parent": (f) => {
    f.responses.get(`${root}/git/commits/${sha}`).parents[1].sha = other
  },
  "wrong synthetic base": (f) => {
    f.responses.get(`${root}/git/commits/${syntheticSha}`).parents[0].sha = other
  },
  "wrong synthetic head": (f) => {
    f.responses.get(`${root}/git/commits/${syntheticSha}`).parents[1].sha = other
  },
  "different source tree": (f) => {
    f.responses.get(`${root}/git/commits/${syntheticSha}`).tree.sha = other
  },
  "unsupported rebase history": (f) => {
    f.responses.get(`${root}/git/commits/${sha}`).parents = [{ sha: other }]
  },
  "wrong workflow": (f) => {
    f.run.path = ".github/workflows/fake.yml"
  },
  "wrong workflow ID": (f) => {
    f.run.workflow_id++
  },
  "wrong repository": (f) => {
    f.run.repository.full_name = "other/repository"
  },
  "push run": (f) => {
    f.run.event = "push"
  },
  "wrong run head": (f) => {
    f.run.head_sha = other
  },
  "job from another run": (f) => {
    f.jobs[1].run_id++
  },
  "arbitrary same-named check": (f) => {
    f.responses.get(`${root}/check-runs/151`).app = { id: 999, slug: "other-app" }
  },
  "check from another suite": (f) => {
    f.responses.get(`${root}/check-runs/151`).check_suite.id++
  },
  "check from another job": (f) => {
    f.responses.get(`${root}/check-runs/151`).details_url += "0"
  },
  "foreign check URL": (f) => {
    f.jobs[1].check_run_url = "https://api.github.com/repos/other/repo/check-runs/151"
  },
  "no associated PR": (f) => {
    f.responses.set(`${root}/commits/${sha}/pulls?per_page=100&page=1`, [])
  },
  "ambiguous associated PR": (f) => {
    f.responses.get(`${root}/commits/${sha}/pulls?per_page=100&page=1`).push(f.pr)
  },
  "API failure": (f) => {
    f.responses.set(`${root}/pulls/1048`, new Error("GitHub unavailable"))
  },
  "superseded main": (f) => {
    f.responses.get(`${root}/git/ref/heads/main`).object.sha = other
  },
}

test("optional job failure does not add a fourth required context", () => {
  const f = fixture()
  f.run.conclusion = "failure"
  assert.equal(f.qualify().sha, sha)
})
for (const [reason, mutate] of Object.entries(rejectionCases)) {
  test(`fails closed: ${reason}`, () => {
    const f = fixture()
    mutate(f)
    assert.throws(f.qualify)
  })
}

test("never accepts an older success in place of a newer pending or failed CI run", () => {
  const f = fixture()
  const endpoint = `${root}/actions/workflows/30/runs?event=pull_request&head_sha=${head}&per_page=100&page=1`
  f.responses.set(endpoint, { total_count: 2, workflow_runs: [f.run, { ...f.run, id: 21 }] })
  f.responses.set(`${root}/actions/runs/21`, {
    ...f.run,
    id: 21,
    status: "queued",
    conclusion: null,
  })
  assert.throws(f.qualify, /latest CI run/)
})

test("paginates associated PRs, CI runs and jobs before qualification", () => {
  const f = fixture()
  const cases = [
    [`${root}/commits/${sha}/pulls?per_page=100&page=`, null, [{ merge_commit_sha: other }]],
    [
      `${root}/actions/workflows/30/runs?event=pull_request&head_sha=${head}&per_page=100&page=`,
      "workflow_runs",
      [{ id: 1 }],
    ],
    [
      `${root}/actions/runs/20/attempts/1/jobs?per_page=100&page=`,
      "jobs",
      [{ name: "Unrelated job" }],
    ],
  ]
  for (const [prefix, key, seed] of cases) {
    const original = f.responses.get(`${prefix}1`)
    const fillers = Array.from({ length: 100 }, (_, i) =>
      key === "workflow_runs" ? { id: -i } : seed[0]
    )
    f.responses.set(
      `${prefix}1`,
      key ? { total_count: 100 + original[key].length, [key]: fillers } : fillers
    )
    f.responses.set(
      `${prefix}2`,
      key ? { ...original, total_count: 100 + original[key].length } : original
    )
  }
  assert.equal(f.qualify().sha, sha)
  assert.equal(f.calls.filter((endpoint) => endpoint.endsWith("page=2")).length, 4)
})

test("rejects truncated pagination receipts", () => {
  const f = fixture()
  f.responses.get(`${root}/actions/runs/20/attempts/1/jobs?per_page=100&page=1`).total_count++
  assert.throws(f.qualify, /incomplete jobs/)
})

test("rechecks main and rerun attempt before granting qualification", () => {
  for (const change of ["main", "attempt"]) {
    const f = fixture()
    let reads = 0
    const endpoint = change === "main" ? `${root}/git/ref/heads/main` : `${root}/actions/runs/20`
    const response = f.responses.get(endpoint)
    Object.defineProperty(response, change === "main" ? "object" : "run_attempt", {
      enumerable: true,
      get() {
        reads++
        return change === "main" ? { sha: reads === 1 ? sha : other } : reads <= 2 ? 1 : 2
      },
    })
    assert.throws(f.qualify, change === "main" ? /main advanced/ : /attempt changed/)
  }
})

test("rejects a new CI run started during qualification", () => {
  const f = fixture()
  let reads = 0
  f.responses.set(
    `${root}/actions/workflows/30/runs?event=pull_request&head_sha=${head}&per_page=100&page=1`,
    () => {
      const runs = ++reads === 1 ? [f.run] : [f.run, { ...f.run, id: 21 }]
      return structuredClone({ total_count: runs.length, workflow_runs: runs })
    }
  )
  assert.throws(f.qualify, /latest CI run changed/)
})
