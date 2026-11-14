import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import {
  readyMergeArgs,
  retryRead,
  runAutoMergeQueue,
  verifyReleaseTriggered,
} from "../auto-merge-queue.mjs"

const repository = "ecryptoguru/lyrashield-ai"
const root = `repos/${repository}`
const main = "a".repeat(40)
const heads = ["b", "c", "d"].map((part) => part.repeat(40))
const syntheticHeads = ["e", "f", "9"].map((part) => part.repeat(40))
const required = [
  "SCA & Secret Scan",
  "Lint, Typecheck, Test & Build",
  "Pinned Engine / Worker Contract",
]

test("confirms the matching push release after an automatic merge", () => {
  let reads = 0
  const sleeps = []
  const run = {
    id: 123,
    head_sha: main,
    head_branch: "main",
    event: "push",
    status: "queued",
    run_attempt: 1,
    repository: { full_name: repository },
    head_repository: { full_name: repository },
  }
  const result = verifyReleaseTriggered(
    (path) => {
      assert.match(path, /release-production\.yml\/runs\?/)
      assert.ok(path.includes(`head_sha=${main}`))
      reads += 1
      return { total_count: reads < 3 ? 0 : 1, workflow_runs: reads < 3 ? [] : [run] }
    },
    main,
    (ms) => sleeps.push(ms)
  )
  assert.equal(result, 123)
  assert.equal(reads, 3)
  assert.deepEqual(sleeps, [2000, 2000])
})

test("does not mistake another source or repository for the merged release", () => {
  const run = {
    id: 123,
    head_sha: main,
    head_branch: "main",
    event: "push",
    status: "queued",
    run_attempt: 1,
    repository: { full_name: repository },
    head_repository: { full_name: repository },
  }
  for (const change of [
    { head_sha: "f".repeat(40) },
    { head_branch: "other" },
    { event: "workflow_dispatch" },
    { repository: { full_name: "other/repo" } },
    { head_repository: { full_name: "other/repo" } },
    { run_attempt: 0 },
  ])
    assert.throws(
      () =>
        verifyReleaseTriggered(
          () => ({ total_count: 1, workflow_runs: [{ ...run, ...change }] }),
          main,
          () => undefined
        ),
      /release run was not observed/
    )
  assert.throws(
    () =>
      verifyReleaseTriggered(
        () => ({ total_count: 2, workflow_runs: [run, { ...run, id: 124 }] }),
        main,
        () => undefined
      ),
    /ambiguous production release runs/
  )
})

function pull(number, overrides = {}) {
  return {
    number,
    state: "open",
    draft: false,
    author_association: "OWNER",
    user: { id: 7, login: "owner" },
    created_at: `2026-11-${String(number).padStart(2, "0")}T00:00:00Z`,
    base: { ref: "main", repo: { full_name: repository } },
    head: { sha: heads[number - 1], repo: { full_name: repository } },
    mergeable: true,
    mergeable_state: "clean",
    auto_merge: null,
    ...overrides,
  }
}

function fixture() {
  const state = {
    pulls: [pull(1)],
    details: new Map(),
    failUpdate: false,
    releases: [{ id: 5, head_sha: main, status: "completed", conclusion: "success" }],
    ci: new Map(
      heads.map((head, index) => [
        head,
        [
          {
            id: 10 + index,
            head_sha: head,
            event: "pull_request",
            repository: { full_name: repository },
            head_repository: { full_name: repository },
            run_attempt: 1,
            check_suite_id: 100 + index,
            status: "completed",
            conclusion: "success",
          },
        ],
      ])
    ),
    checks: new Map(
      heads.map((head, index) => [
        head,
        required.map((name, offset) => ({
          id: 20 + index * 10 + offset,
          name,
          head_sha: head,
          check_suite: { id: 100 + index },
          app: { id: 15368 },
          status: "completed",
          conclusion: "success",
        })),
      ])
    ),
    testedBase: main,
    mergeBase: main,
    ciReads: 0,
    onSecondCiRead: null,
    actions: [],
  }
  const api = (url) => {
    const [path, query = ""] = url.split("?")
    const params = new URLSearchParams(query)
    const page = Number(params.get("page") ?? "1")
    const paginate = (items, key) => {
      const selected = items.slice((page - 1) * 100, page * 100)
      return key ? { total_count: items.length, [key]: selected } : selected
    }
    if (path === `${root}/git/ref/heads/main`) return { object: { sha: main } }
    if (path === `${root}/pulls`) return paginate(state.pulls)
    if (path.startsWith(`${root}/pulls/`)) {
      const number = Number(path.split("/").at(-1))
      return state.details.get(number) ?? state.pulls.find((pr) => pr.number === number)
    }
    if (path === `${root}/actions/workflows/release-production.yml/runs`) {
      const status = params.get("status")
      const sha = params.get("head_sha")
      return paginate(
        state.releases.filter(
          (run) => (!status || run.status === status) && (!sha || run.head_sha === sha)
        ),
        "workflow_runs"
      )
    }
    if (path === `${root}/actions/workflows/ci.yml/runs`) {
      state.ciReads += 1
      if (state.ciReads === 2) state.onSecondCiRead?.()
      return paginate(state.ci.get(params.get("head_sha")) ?? [], "workflow_runs")
    }
    const jobs = new RegExp(`^${root}/actions/runs/(\\d+)/attempts/(\\d+)/jobs$`).exec(path)
    if (jobs) {
      const run = [...state.ci.values()].flat().find((value) => value.id === Number(jobs[1]))
      if (!run || run.run_attempt !== Number(jobs[2])) return paginate([], "jobs")
      const index = heads.indexOf(run.head_sha)
      const checks = state.checks.get(run.head_sha) ?? []
      const latest = required.flatMap((name) => {
        const item = checks.filter((check) => check.name === name).sort((a, b) => b.id - a.id)[0]
        return item
          ? [
              {
                id: item.id,
                name: item.name,
                status: item.status,
                conclusion: item.conclusion,
                run_id: run.id,
                head_sha: run.head_sha,
                check_run_url: `https://api.github.com/${root}/check-runs/${item.id}`,
              },
            ]
          : []
      })
      const receipt = {
        name: `Detect changed paths [source: pr=${index + 1} base=${state.testedBase} head=${run.head_sha} merge=${syntheticHeads[index]}]`,
        status: "completed",
        conclusion: "success",
        run_id: run.id,
        head_sha: run.head_sha,
      }
      return paginate([receipt, ...latest], "jobs")
    }
    const check = new RegExp(`^${root}/check-runs/(\\d+)$`).exec(path)
    if (check) {
      const entry = [...state.checks]
        .flatMap(([head, values]) => values.map((value) => ({ head, value })))
        .find(({ value }) => value.id === Number(check[1]))
      if (!entry) throw new Error("missing check fixture")
      const run = state.ci.get(entry.head)[0]
      return {
        ...entry.value,
        app: { ...entry.value.app, slug: "github-actions" },
        details_url: `https://github.com/${repository}/actions/runs/${run.id}/job/${entry.value.id}`,
      }
    }
    const commit = new RegExp(`^${root}/git/commits/([a-f0-9]{40})$`).exec(path)
    if (commit) {
      const index = syntheticHeads.indexOf(commit[1])
      return { sha: commit[1], parents: [{ sha: state.mergeBase }, { sha: heads[index] }] }
    }
    throw new Error(`Unexpected API request ${url}`)
  }
  return {
    state,
    run: () =>
      runAutoMergeQueue({
        api,
        updateBranch: (number, head) => {
          if (state.failUpdate) {
            const error = new Error("Command failed")
            error.stderr = "gh: refusing to allow a GitHub App to create or update workflow"
            throw error
          }
          state.actions.push(["update", number, head])
        },
        mergeReady: (number, head) => state.actions.push(["merge", number, head]),
        disableAutoMerge: (number, head) => state.actions.push(["disable", number, head]),
      }),
  }
}

test("a ready merge is immediate and head-bound, without a persistent auto-merge request", () => {
  assert.deepEqual(readyMergeArgs(1, heads[0]), [
    "api",
    "--method",
    "PUT",
    `${root}/pulls/1/merge`,
    "-f",
    `sha=${heads[0]}`,
    "-f",
    "merge_method=squash",
  ])
})

test("queues exactly one trusted PR with its observed head", () => {
  const f = fixture()
  f.state.pulls.push(pull(2))
  assert.deepEqual(f.run(), { action: "auto-merge", number: 1 })
  assert.deepEqual(f.state.actions, [["merge", 1, heads[0]]])
})

test("updates a stale branch once before requesting auto-merge", () => {
  const f = fixture()
  f.state.pulls[0].mergeable_state = "behind"
  assert.deepEqual(f.run(), { action: "update", number: 1 })
  assert.deepEqual(f.state.actions, [["update", 1, heads[0]]])
})

test("merges a ready PR before refreshing a stale candidate", () => {
  const f = fixture()
  f.state.pulls[0].mergeable_state = "behind"
  f.state.pulls.push(pull(2))
  assert.deepEqual(f.run(), { action: "auto-merge", number: 2 })
  assert.deepEqual(f.state.actions, [["merge", 2, heads[1]]])
})

test("waits for an already-running candidate before refreshing another branch", () => {
  const f = fixture()
  f.state.ci.get(heads[0])[0].status = "queued"
  f.state.ci.get(heads[0])[0].conclusion = null
  f.state.pulls.push(pull(2, { mergeable_state: "behind" }))
  assert.deepEqual(f.run(), { action: "wait", reason: "checks pending", number: 1 })
  assert.deepEqual(f.state.actions, [])
})

test("a pending candidate does not block another candidate whose checks passed", () => {
  const f = fixture()
  f.state.ci.get(heads[0])[0].status = "queued"
  f.state.ci.get(heads[0])[0].conclusion = null
  f.state.pulls.push(pull(2))
  assert.deepEqual(f.run(), { action: "auto-merge", number: 2 })
  assert.deepEqual(f.state.actions, [["merge", 2, heads[1]]])
})

test("a candidate with no CI run does not prevent refreshing a stale branch", () => {
  const f = fixture()
  f.state.ci.set(heads[0], [])
  f.state.pulls.push(pull(2, { mergeable_state: "behind" }))
  assert.deepEqual(f.run(), { action: "update", number: 2 })
  assert.deepEqual(f.state.actions, [["update", 2, heads[1]]])
})

test("waits briefly for CI to appear after a branch update", () => {
  const f = fixture()
  f.state.ci.set(heads[0], [])
  f.state.pulls[0].updated_at = new Date().toISOString()
  f.state.pulls.push(pull(2, { mergeable_state: "behind" }))
  assert.deepEqual(f.run(), { action: "wait", reason: "checks pending", number: 1 })
  assert.deepEqual(f.state.actions, [])
})

test("an old queued CI run does not permanently block other candidates", () => {
  const f = fixture()
  Object.assign(f.state.ci.get(heads[0])[0], {
    status: "queued",
    conclusion: null,
    updated_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  })
  f.state.pulls.push(pull(2, { mergeable_state: "behind" }))
  assert.deepEqual(f.run(), { action: "update", number: 2 })
  assert.deepEqual(f.state.actions, [["update", 2, heads[1]]])
})

test("keeps an existing qualified auto-merge request", () => {
  const f = fixture()
  f.state.pulls[0].mergeable_state = "blocked"
  f.state.pulls[0].auto_merge = { enabled_by: { login: "owner" } }
  f.state.pulls.push(pull(2))
  assert.deepEqual(f.run(), { action: "wait", reason: "checks pending", number: 1 })
  assert.deepEqual(f.state.actions, [])
})

test("a completed failing CI does not block another PR", () => {
  const f = fixture()
  f.state.pulls[0].mergeable_state = "unstable"
  f.state.checks.get(heads[0])[0].conclusion = "failure"
  f.state.pulls.push(pull(2))
  assert.deepEqual(f.run(), { action: "auto-merge", number: 2 })
})

test("turns off a failed required security check before advancing the queue", () => {
  const f = fixture()
  f.state.pulls[0].mergeable_state = "unstable"
  f.state.pulls[0].auto_merge = { enabled_by: { login: "owner" } }
  f.state.checks.set(heads[0], [
    {
      id: 12,
      name: "SCA & Secret Scan",
      head_sha: heads[0],
      check_suite: { id: 100 },
      app: { id: 15368 },
      status: "completed",
      conclusion: "failure",
    },
  ])
  f.state.pulls.push(pull(2))
  assert.deepEqual(f.run(), { action: "disable-auto-merge", number: 1 })
  assert.deepEqual(f.state.actions, [["disable", 1, heads[0]]])
})

test("reduces several already-enabled requests to one before queuing others", () => {
  const f = fixture()
  f.state.pulls[0].auto_merge = { enabled_by: { login: "owner" } }
  f.state.pulls.push(pull(2, { auto_merge: { enabled_by: { login: "owner" } } }))
  assert.deepEqual(f.run(), { action: "disable-auto-merge", number: 2 })
  assert.deepEqual(f.state.actions, [["disable", 2, heads[1]]])
})

test("holds an already-enabled request while production is changing", () => {
  const f = fixture()
  f.state.pulls[0].auto_merge = { enabled_by: { login: "owner" } }
  f.state.releases.push({ id: 6, head_sha: main, status: "in_progress", conclusion: null })
  assert.deepEqual(f.run(), { action: "disable-auto-merge", number: 1 })
  assert.deepEqual(f.state.actions, [["disable", 1, heads[0]]])
})

test("waits for a newer required check rerun before enabling merge", () => {
  const f = fixture()
  f.state.ci.get(heads[0])[0].status = "in_progress"
  f.state.ci.get(heads[0])[0].conclusion = null
  f.state.checks.set(heads[0], [
    {
      id: 12,
      name: "SCA & Secret Scan",
      head_sha: heads[0],
      check_suite: { id: 100 },
      app: { id: 15368 },
      status: "completed",
      conclusion: "failure",
    },
    {
      id: 13,
      name: "SCA & Secret Scan",
      head_sha: heads[0],
      check_suite: { id: 100 },
      app: { id: 15368 },
      status: "in_progress",
      conclusion: null,
    },
  ])
  assert.deepEqual(f.run(), { action: "wait", reason: "checks pending", number: 1 })
})

test("does not block successful required checks because an optional CI job failed", () => {
  const f = fixture()
  f.state.pulls[0].mergeable_state = "unstable"
  f.state.ci.get(heads[0])[0].conclusion = "failure"
  f.state.checks.set(
    heads[0],
    required.map((name, index) => ({
      id: 20 + index,
      name,
      head_sha: heads[0],
      check_suite: { id: 100 },
      app: { id: 15368 },
      status: "completed",
      conclusion: "success",
    }))
  )
  assert.deepEqual(f.run(), { action: "auto-merge", number: 1 })
})

test("does not enable auto-merge for skipped or stale required evidence", () => {
  const skipped = fixture()
  skipped.state.checks.get(heads[0])[0].conclusion = "skipped"
  assert.deepEqual(skipped.run(), { action: "wait", reason: "no eligible pull requests" })
  assert.deepEqual(skipped.state.actions, [])

  const stale = fixture()
  stale.state.checks.get(heads[0])[0].check_suite.id = 999
  assert.deepEqual(stale.run(), { action: "wait", reason: "no eligible pull requests" })
  assert.deepEqual(stale.state.actions, [])
})

test("rejects a source receipt or tested merge with the wrong base", () => {
  for (const property of ["testedBase", "mergeBase"]) {
    const f = fixture()
    f.state[property] = "9".repeat(40)
    assert.deepEqual(f.run(), { action: "wait", reason: "no eligible pull requests" })
    assert.deepEqual(f.state.actions, [])
  }
})

test("does not merge if the qualifying CI run is cancelled during verification", () => {
  const f = fixture()
  f.state.onSecondCiRead = () => {
    const run = f.state.ci.get(heads[0])[0]
    f.state.ci.set(heads[0], [{ ...run, status: "completed", conclusion: "cancelled" }])
  }
  assert.deepEqual(f.run(), { action: "wait", reason: "checks pending", number: 1 })
  assert.deepEqual(f.state.actions, [])
})

test("holds a previously enabled auto-merge until every required check succeeds", () => {
  const f = fixture()
  f.state.pulls[0].auto_merge = { enabled_by: { login: "owner" } }
  f.state.checks.get(heads[0])[0].status = "in_progress"
  f.state.checks.get(heads[0])[0].conclusion = null
  assert.deepEqual(f.run(), { action: "disable-auto-merge", number: 1 })
  assert.deepEqual(f.state.actions, [["disable", 1, heads[0]]])
})

test("does not queue another PR while an untrusted auto-merge request is active", () => {
  const f = fixture()
  f.state.pulls.push(
    pull(2, { author_association: "NONE", auto_merge: { enabled_by: { login: "owner" } } })
  )
  assert.deepEqual(f.run(), { action: "wait", reason: "untrusted auto-merge request is active" })
  assert.deepEqual(f.state.actions, [])
})

test("waits while a release is active, but ignores an obsolete queued run", () => {
  const f = fixture()
  f.state.releases.push({ id: 6, head_sha: "e".repeat(40), status: "queued", conclusion: null })
  assert.equal(f.run().action, "auto-merge")
  f.state.actions.length = 0
  f.state.releases.push({
    id: 7,
    head_sha: "e".repeat(40),
    status: "in_progress",
    conclusion: null,
  })
  assert.equal(f.run().reason, "production release in progress")
  assert.deepEqual(f.state.actions, [])
})

test("does not merge during the gap before the current main release appears", () => {
  const f = fixture()
  f.state.releases = []
  assert.deepEqual(f.run(), { action: "wait", reason: "current main release not observed" })
  assert.deepEqual(f.state.actions, [])
})

test("a failed current release holds dependencies while allowing a product repair", () => {
  const f = fixture()
  f.state.releases[0].conclusion = "failure"
  f.state.pulls = [
    pull(1, {
      user: { id: 49699333, login: "dependabot[bot]" },
      author_association: "CONTRIBUTOR",
    }),
  ]
  assert.equal(f.run().reason, "no eligible pull requests")
  f.state.pulls.push(pull(2))
  assert.deepEqual(f.run(), { action: "auto-merge", number: 2 })
})

test("rejects fork, untrusted author, spoofed bot, draft, and changed head", () => {
  const f = fixture()
  f.state.pulls = [
    pull(1, { author_association: "NONE" }),
    pull(2, { user: { id: 3, login: "dependabot[bot]" }, author_association: "CONTRIBUTOR" }),
    pull(3, { head: { sha: heads[2], repo: { full_name: "other/fork" } } }),
  ]
  assert.equal(f.run().reason, "no eligible pull requests")
  f.state.pulls = [pull(1, { draft: true }), pull(2)]
  f.state.details.set(2, pull(2, { head: { sha: heads[2], repo: { full_name: repository } } }))
  assert.equal(f.run().reason, "no eligible pull requests")
  assert.deepEqual(f.state.actions, [])
})

test("updates a behind pull request even when it touches workflows", () => {
  const f = fixture()
  f.state.pulls = [pull(1, { mergeable_state: "behind" })]
  assert.deepEqual(f.run(), { action: "update", number: 1 })
  assert.deepEqual(f.state.actions, [["update", 1, heads[0]]])
})

test("holds a behind pull request when GitHub refuses the branch update", () => {
  const f = fixture()
  f.state.pulls = [pull(1, { mergeable_state: "behind" })]
  f.state.failUpdate = true
  assert.deepEqual(f.run(), { action: "disable-auto-merge", number: 1 })
  assert.deepEqual(f.state.actions, [["disable", 1, heads[0]]])
})

test("refuses to mutate when a required check is not bound to GitHub Actions", () => {
  const f = fixture()
  f.state.checks.get(heads[0])[0].app.id = 10
  assert.equal(f.run().reason, "no eligible pull requests")
  assert.deepEqual(f.state.actions, [])
})

test("retries only transient GitHub reads with a fixed bound", () => {
  let count = 0
  const delays = []
  assert.equal(
    retryRead(
      () => {
        count += 1
        if (count < 3) throw Object.assign(new Error("temporary"), { stderr: "HTTP 503" })
        return "ok"
      },
      (ms) => delays.push(ms)
    ),
    "ok"
  )
  assert.deepEqual(delays, [500, 1000])
  count = 0
  assert.throws(
    () =>
      retryRead(
        () => {
          count += 1
          throw Object.assign(new Error("denied"), { stderr: "HTTP 403" })
        },
        () => {}
      ),
    /denied/
  )
  assert.equal(count, 1)
})

test("privileged workflow checks out only trusted main and uses an app token", () => {
  // Static repository fixture; the path is not supplied by an external caller.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const workflow = readFileSync(
    new URL("../../workflows/automatic-merge.yml", import.meta.url),
    "utf8"
  )
  assert.match(workflow, /pull_request_target:/)
  assert.match(workflow, /ref: main/)
  assert.match(workflow, /persist-credentials: false/)
  assert.match(workflow, /create-github-app-token@[0-9a-f]{40}/)
  assert.doesNotMatch(workflow, /head\.sha|head\.ref|pull_request\.head/)
})

test("a transiently skewed run total is re-read instead of failing the queue", () => {
  let reads = 0
  const path = `${root}/actions/workflows/release-production.yml/runs?branch=main&status=in_progress`
  const api = () => {
    reads += 1
    // First read leads the rows it serves; the re-read agrees with them.
    return { total_count: reads === 1 ? 1 : 0, workflow_runs: [] }
  }
  // The queue decision itself is exercised by runAutoMergeQueue; this pins the
  // pagination helper's contract through the exported entry point.
  const result = runAutoMergeQueue({
    api: (endpoint) => {
      if (endpoint.includes("/git/ref/heads/main")) return { object: { sha: main } }
      if (endpoint.includes("/pulls?")) return []
      return api()
    },
    updateBranch: () => assert.fail("no branch update"),
    mergeReady: () => assert.fail("no merge"),
    disableAutoMerge: () => assert.fail("no auto-merge disable"),
  })
  assert.equal(result.action, "wait")
  assert.ok(reads >= 2)
})

test("a persistent paginated mismatch still fails closed", () => {
  const path = `${root}/actions/workflows/release-production.yml/runs?branch=main&status=in_progress`
  assert.throws(
    () =>
      runAutoMergeQueue({
        api: (endpoint) => {
          if (endpoint.includes("/git/ref/heads/main")) return { object: { sha: main } }
          if (endpoint.includes("/pulls?")) return []
          assert.ok(endpoint.includes("release-production"))
          return { total_count: 1, workflow_runs: [] }
        },
        updateBranch: () => assert.fail("no branch update"),
        mergeReady: () => assert.fail("no merge"),
        disableAutoMerge: () => assert.fail("no auto-merge disable"),
      }),
    /incomplete paginated response/
  )
})
