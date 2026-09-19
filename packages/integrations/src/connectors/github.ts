/**
 * Read-only GitHub connector tools.
 *
 * Credentials are the workspace's GitHub App installation, minted on demand
 * through the existing provider module (`getInstallationToken`); nothing is
 * persisted per call. Every tool issues GET requests only — the registered
 * relay profile for this provider (`CONNECTOR_RELAY_PROFILES.github` in
 * @lyrashield/security) allows GET/HEAD to `api.github.com` and nothing else,
 * so a mutated tool cannot smuggle a write through the scoped egress path.
 */
import {
  GITHUB_API_BASE,
  GITHUB_HEADERS,
  getFileContent,
  getInstallationToken,
  githubFetch,
} from "../github"
import {
  optionalEnumField,
  stringField,
  isRecord,
  type ConnectorInvocationContext,
  type ConnectorTool,
} from "./types"

const MAX_LIST_ITEMS = 20
const MAX_FILE_BYTES = 64 * 1024
const MAX_OUTPUT_BYTES = 96 * 1024

const GITHUB_OWNER_REPO = /^[A-Za-z0-9_.-]{1,100}$/

export class GitHubConnectorError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = "GitHubConnectorError"
  }
}

function installationIdOf(ctx: ConnectorInvocationContext): number {
  if (ctx.credential.kind !== "github_installation") {
    throw new GitHubConnectorError("GitHub connector requires an installation credential")
  }
  return ctx.credential.installationId
}

async function authedFetch(
  ctx: ConnectorInvocationContext,
  path: string
): Promise<Record<string, unknown> | unknown[]> {
  const token = await getInstallationToken(installationIdOf(ctx))
  const res = await githubFetch(
    `${GITHUB_API_BASE}${path}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, ...GITHUB_HEADERS },
      signal: ctx.signal,
    },
    3,
    ctx.fetchFn
  )
  if (!res.ok) {
    // Never echo the provider body — it can carry request echoes or scopes.
    throw new GitHubConnectorError(`GitHub API request failed`, res.status)
  }
  return (await res.json()) as Record<string, unknown> | unknown[]
}

function repoParts(input: Record<string, unknown>) {
  const owner = stringField(input, "owner", { max: 100, pattern: GITHUB_OWNER_REPO })
  if (!owner.ok) return owner
  const repo = stringField(input, "repo", { max: 100, pattern: GITHUB_OWNER_REPO })
  if (!repo.ok) return repo
  return { ok: true as const, owner: owner.value, repo: repo.value }
}

/** Narrow projection — the model sees bounded fields, not the raw provider body. */
function projectRepo(data: Record<string, unknown>) {
  const owner = isRecord(data.owner) ? data.owner : {}
  return {
    id: data.id,
    fullName: data.full_name,
    name: data.name,
    owner: owner.login,
    description: typeof data.description === "string" ? data.description.slice(0, 500) : null,
    defaultBranch: data.default_branch,
    private: data.private,
    language: data.language,
    htmlUrl: data.html_url,
    openIssuesCount: data.open_issues_count,
    pushedAt: data.pushed_at,
  }
}

function projectPull(item: unknown) {
  const pr = isRecord(item) ? item : {}
  const user = isRecord(pr.user) ? pr.user : {}
  const head = isRecord(pr.head) ? pr.head : {}
  const base = isRecord(pr.base) ? pr.base : {}
  return {
    number: pr.number,
    title: typeof pr.title === "string" ? pr.title.slice(0, 300) : null,
    state: pr.state,
    draft: pr.draft === true,
    author: user.login ?? null,
    headSha: typeof head.sha === "string" ? head.sha : null,
    baseRef: typeof base.ref === "string" ? base.ref : null,
    mergedAt: pr.merged_at ?? null,
    htmlUrl: pr.html_url,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
  }
}

function projectIssue(item: unknown) {
  const issue = isRecord(item) ? item : {}
  const user = isRecord(issue.user) ? issue.user : {}
  const labels = Array.isArray(issue.labels)
    ? issue.labels
        .map((l) => (isRecord(l) && typeof l.name === "string" ? l.name : null))
        .filter((l): l is string => l !== null)
        .slice(0, 10)
    : []
  return {
    number: issue.number,
    title: typeof issue.title === "string" ? issue.title.slice(0, 300) : null,
    state: issue.state,
    author: user.login ?? null,
    labels,
    comments: typeof issue.comments === "number" ? issue.comments : null,
    htmlUrl: issue.html_url,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
  }
}

export const githubConnectorTools: ConnectorTool[] = [
  {
    name: "github.get_repository",
    provider: "github",
    description:
      "Read repository metadata (default branch, visibility, primary language) for scan context.",
    requiredScope: "repo:metadata",
    readOnly: true,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    validateInput(input) {
      if (!isRecord(input)) return { ok: false, reason: "input must be an object" }
      const parts = repoParts(input)
      if (!parts.ok) return parts
      return { ok: true, value: { owner: parts.owner, repo: parts.repo } }
    },
    async execute(ctx, input) {
      const { owner, repo } = input as { owner: string; repo: string }
      const data = await authedFetch(
        ctx,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
      )
      return projectRepo(isRecord(data) ? data : {})
    },
  },
  {
    name: "github.list_pull_requests",
    provider: "github",
    description:
      "List recent pull requests (number, title, state, head SHA) for a repository connection.",
    requiredScope: "repo:pull_requests",
    readOnly: true,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    validateInput(input) {
      if (!isRecord(input)) return { ok: false, reason: "input must be an object" }
      const parts = repoParts(input)
      if (!parts.ok) return parts
      const state = optionalEnumField(input, "state", ["open", "closed", "all"] as const)
      if (!state.ok) return state
      return {
        ok: true,
        value: { owner: parts.owner, repo: parts.repo, state: state.value ?? "open" },
      }
    },
    async execute(ctx, input) {
      const { owner, repo, state } = input as { owner: string; repo: string; state: string }
      const data = await authedFetch(
        ctx,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?per_page=${MAX_LIST_ITEMS}&state=${state}`
      )
      const items = Array.isArray(data) ? data.slice(0, MAX_LIST_ITEMS).map(projectPull) : []
      return { pullRequests: items, count: items.length }
    },
  },
  {
    name: "github.list_issues",
    provider: "github",
    description: "List recent issues (number, title, labels) — pull requests are excluded.",
    requiredScope: "repo:issues",
    readOnly: true,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    validateInput(input) {
      if (!isRecord(input)) return { ok: false, reason: "input must be an object" }
      const parts = repoParts(input)
      if (!parts.ok) return parts
      const state = optionalEnumField(input, "state", ["open", "closed", "all"] as const)
      if (!state.ok) return state
      return {
        ok: true,
        value: { owner: parts.owner, repo: parts.repo, state: state.value ?? "open" },
      }
    },
    async execute(ctx, input) {
      const { owner, repo, state } = input as { owner: string; repo: string; state: string }
      const data = await authedFetch(
        ctx,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?per_page=${MAX_LIST_ITEMS}&state=${state}`
      )
      // The issues endpoint also returns PRs — exclude them so the tool's
      // contract matches its name.
      const items = Array.isArray(data)
        ? data
            .filter((i) => !(isRecord(i) && "pull_request" in i))
            .slice(0, MAX_LIST_ITEMS)
            .map(projectIssue)
        : []
      return { issues: items, count: items.length }
    },
  },
  {
    name: "github.get_file",
    provider: "github",
    description: "Read a single file's text content at a ref (branch or immutable SHA).",
    requiredScope: "repo:contents",
    readOnly: true,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    validateInput(input) {
      if (!isRecord(input)) return { ok: false, reason: "input must be an object" }
      const parts = repoParts(input)
      if (!parts.ok) return parts
      const path = stringField(input, "path", { max: 1024 })
      if (!path.ok) return path
      if (path.value.includes("..")) {
        return { ok: false, reason: "path must not contain '..'" }
      }
      const ref = stringField(input, "ref", { max: 255 })
      if (!ref.ok) return ref
      return {
        ok: true,
        value: { owner: parts.owner, repo: parts.repo, path: path.value, ref: ref.value },
      }
    },
    async execute(ctx, input) {
      const { owner, repo, path, ref } = input as {
        owner: string
        repo: string
        path: string
        ref: string
      }
      const content = await getFileContent(installationIdOf(ctx), owner, repo, path, ref)
      if (content === null) return { path, ref, found: false as const }
      const bytes = Buffer.byteLength(content, "utf8")
      return {
        path,
        ref,
        found: true as const,
        contentBytes: bytes,
        content:
          bytes > MAX_FILE_BYTES
            ? Buffer.from(content, "utf8").subarray(0, MAX_FILE_BYTES).toString("utf8")
            : content,
        truncated: bytes > MAX_FILE_BYTES,
      }
    },
  },
]
