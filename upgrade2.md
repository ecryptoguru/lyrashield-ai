# LyraShield AI — Agentic Security/Trust SaaS: Coding-Agent Handoff (PR1–PR3)

Dev-ready implementation handoff for the agent-integration program: typed agent registry, /api/v1 + OpenAPI, shared SDK, lyrashield CLI with real installers for 15 coding agents, per-agent rules/skill files, and remote out-of-band approval. Code-grounded at main @ cef548d. Founder-approved 2026-07-31.

## 0. Purpose, Status & Scope

**Status:** Founder-approved 2026-07-31 by Ankit Das, with three explicit decisions recorded in §1.3.

**Baseline:** github.com/ecryptoguru/lyrashield-ai, branch main, commit **cef548d**. Every fact in this document was read out of that tree or verified against the live npm registry — none of it is recalled from memory. Anything that could not be verified is listed in §11 _Must-Verify — Do Not Guess_, and must be checked before it is coded, not assumed.

**Goal:** turn LyraShield's 15 _documented_ coding-agent integrations into 15 _real_ integrations, add the missing CLI, ship per-agent rules and skill files, and unlock cloud agents — so that "agentic security/trust SaaS for coding agents" describes the product rather than positioning it.

**Three PRs, in order. Do not reorder them** — the reason for the sequence is in §4.1.

| PR       | Contents                                                                                                                                           | Branch                      |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **PR 1** | Phase 0 + 1 — agent registry, /api/v1, OpenAPI, @lyrashield/sdk, lyrashield CLI, installers for all 15 agents, conformance suite, regenerated docs | feat/agent-registry-and-cli |
| **PR 2** | Phase 2 — one canonical security policy rendered as per-agent rules/skill/plugin files                                                             | feat/agent-rules-and-skills |
| **PR 3** | Phase 3 — remote MCP out-of-band approval, unlocking Lovable / Bolt / Replit / v0                                                                  | feat/remote-mcp-approval    |

**Explicitly out of scope for these three PRs:** agent-scoped identity, the per-agent trust record, and any Prisma migration. The founder deferred that to a fast-follow once real install telemetry exists (§9). Do not add a migration to PR 1–3.

**Who this is for:** a coding agent (or engineer) implementing against the real tree. It assumes no prior context from the planning conversation.

## 1. Ground Truth — Verified Repo State

### 1.1 What already exists and works — do not rebuild it

**The MCP server is real and published.** packages/mcp v0.2.0 is live on npm as **@lyrashield/mcp@0.2.0**, published 2026-07-24 (confirmed against registry.npmjs.org; dist-tags.latest = 0.2.0, single version). Every docs page that tells a user to run npx -y @lyrashield/mcp is telling the truth. It ships:

- **14 tools** — 9 read (lyrashield_list_workspaces, list_targets, get_scan_status, get_findings, explain_finding, generate_fix_plan, get_launch_readiness, create_pr_security_recap, check_diff) and 5 write (scan_target, run_pr_scan, record_fix_proposal, verify_fix, create_report).
- **Two transports** — stdio (bin: lyrashield-mcp → dist/stdio-transport.js) and remote Streamable HTTP served by apps/web/src/app/api/mcp/route.ts.
- **A real approval architecture** — MCP elicitation, falling back to a TTY prompt, **failing closed** when no approval channel exists. src/prompt-injection-guard.ts with tests. Read-only keys are additionally rejected server-side for writes.
- **ToolHandlerContext + a private apiCall helper** in src/tools.ts that already implements the { success, data, error } envelope, Bearer auth and a 30s AbortController timeout. **This helper is what PR 1 extracts into the SDK** — see §5.4.

**All 15 agents already have docs pages** under apps/marketing/src/pages/docs/integrations/, plus remote-mcp, github-action, rest-api, agent-rules and troubleshooting. The index is dated 2026-07-24 and carries FAQPage JSON-LD. These are accurate but **manual** — they instruct humans to hand-edit config files.

**The GitHub Action** (action.yml, repo root) is a composite action: diff-aware, SARIF-emitting, SHA-pinned, running entirely in the customer's runner with the customer's GITHUB_TOKEN (gitleaks + dependency audit + risky-pattern checks). It deliberately does _not_ call the hosted engine. The CLI's gate command must match its semantics, not replace it.

**An agentic-trust primitive already exists in the engine.** apps/worker/src/engine/scanners/agent-config-scanner.ts reads AGENTS.md, CLAUDE.md, .cursorrules, .windsurfrules and .github/copilot-instructions.md, and flags dangerous instruction clauses against DANGEROUS_INSTRUCTION_PATTERNS, with a PROTECTIVE_INSTRUCTION_PATTERNS allowlist. **This directly constrains PR 2** — see §7.4.

**AgentApproval already exists.** The Prisma model plus /api/agent-approvals, /api/agent-approvals/[id]/approve and /api/agent-approvals/[id]/deny are all implemented. PR 3 wires this existing primitive to remote MCP; it does not invent it.

**The honesty vocabulary is a product asset.** docs/vibe-security-50.md and packages/security/src/vibe-security-controls.ts define DETECTED / NO_FINDING / INCONCLUSIVE / NOT_APPLICABLE / EVIDENCE_REQUIRED, with an explicit prohibition on rendering passed or clean merely because nothing was returned. **The installer must inherit this discipline** — see §4.4.

### 1.2 The seven gaps this program closes

1. **No CLI exists.** The only bin in the entire monorepo is lyrashield-mcp. There is no packages/cli. Both lyrashield (unscoped) and @lyrashield/cli returned **HTTP 404** on the npm registry — both are unclaimed and available.
2. **The 15 "integrations" are documentation, not automation.** Each agent uses a different path, format and root key. Nothing writes them.
3. **No skill or plugin packages.** agent-rules.astro has exactly three paste-in snippets (CLAUDE.md, AGENTS.md, .cursorrules). Nothing for Copilot instructions, Cursor .mdc rules, Windsurf workflows, Claude Code plugins/hooks, or OpenClaw skills.
4. **The API is unversioned with no machine contract.** ~45 routes under /api/*, no /api/v1, and no OpenAPI or Swagger file anywhere in the tree. **This is the program's only one-way door.**
5. **Remote MCP is read-only in practice.** Mutating tools are refused over HTTP by default — correctly, since a stateless request has no human to prompt. Every cloud agent can therefore look but never act.
6. **No agent identity.** Keys are workspace-scoped (ApiKey.scopes: String[], values "read" | "write"). LyraShield cannot say _which_ agent acted, nor revoke or rate-limit one agent. (Deferred — §9.)
7. **No conformance harness.** Nothing fails CI when a vendor renames a config key, and vendors rename config keys often. Across 15 targets this is guaranteed silent breakage.

### 1.3 Founder decisions — 2026-07-31

1. **Claim both npm names.** Unscoped **lyrashield is primary** (npx lyrashield init); **@lyrashield/cli is published as an alias** exposing the same bin. Publishing is irreversible → gated on founder sign-off (§10).
2. **PR 1 = Phase 0 + Phase 1 together.** The pieces are only meaningful as a set: a registry with no installer, or a CLI aimed at unversioned paths, is worse than not shipping.
3. **Phase 4 (agent identity) is a fast-follow, not part of this program.** Ship PR 1–3 first and revisit once real install telemetry exists. **No Prisma migration in PR 1–3.**

## 2. Hard Guardrails — Non-Negotiable

These are not style preferences. Violating any of them is grounds for rejecting the PR.

### 2.1 Never leak a key into a shared file — the highest-severity trap

The docs for Claude Code (.mcp.json) and Cursor (.cursor/mcp.json) **explicitly tell users to commit these files to share config with their team**. Writing a raw lsk_… key into either one would make LyraShield's own installer a secret-exfiltration vector — the exact class of finding the product sells against (docs/plans/2026-07-14-vibe-coder-security-seo-tools-plan.md ranks "API keys exposed in frontend bundles" as the #3 issue LyraShield owns editorially).

**Rules:**

- For any config file that is project-local and plausibly committed (.mcp.json, .cursor/mcp.json, .vscode/mcp.json, opencode.json, kilo.jsonc), **never write a literal key by default.** Emit an env reference in whatever syntax that agent supports, and have the CLI set the variable in the user's shell profile or a gitignored .env — or instruct them to.
- Where the agent supports interpolation, use it: {env:LYRASHIELD_API_KEY} for OpenCode and Kilo Code (single-brace — see §5.2).
- Where an agent requires a literal inline value and the file is global (not committed) — Windsurf, Zed, Gemini CLI, Codex — inlining is acceptable. Warn the user which file now contains a secret and set the file mode to 0600.
- Where an agent requires a literal value in a _project_ file, **refuse to inline by default**. Require an explicit --inline-secret flag, print a warning naming the leak risk, and check whether the file is git-tracked and ungitignored — if it is, refuse outright.
- If the CLI writes or touches .env, ensure .env is gitignored; if it is not, say so and do not write.

### 2.2 Never clobber a user's other MCP servers

The CLI edits files it does not own, containing other vendors' servers and unrelated settings (Zed and VS Code configs in particular are general-purpose settings files).

- **Merge, never replace.** Parse, insert/update only the lyrashield entry, serialise back. Never rewrite a whole file from a template.
- **Preserve formatting and comments.** kilo.jsonc is JSONC — a naive JSON.parse/stringify round-trip destroys comments. Use a comment-preserving editor (e.g. jsonc-parser's edit API) for JSONC, and a format-preserving TOML/YAML editor for Codex/OpenClaw/Hermes. Do not hand-roll serialisers.
- **Timestamped backup before every write**, e.g. <file>.lyrashield-backup-<ISO8601>. Report the path.
- **Idempotent.** Running init twice must produce a byte-identical file the second time and report "already configured", not a duplicate entry.
- **--dry-run must be a first-class, discoverable flag** that prints the exact diff and writes nothing.
- **Never touch unrelated keys.** A diff that changes anything outside the lyrashield entry is a bug.

### 2.3 Secret storage in the CLI

- Do **not** add a native-module keychain dependency (keytar-class). The CLI is distributed via npx; a native build step is a reliability hazard on install, and there is no keychain dependency anywhere in the tree today.
- **Primary store:** ~/.lyrashield/credentials.json, file mode 0600, parent dir 0700. This is the pattern gh and vercel use.
- OS keychain support may be added later behind an **optional** dependency that degrades gracefully. Not required for PR 1.
- **Never log a key.** Redact to lsk_… + last 4. Never echo it in --dry-run output, error messages, or doctor output.
- LYRASHIELD_API_KEY in the environment always wins over the stored credential, so CI needs no state.

### 2.4 Additive only — break nothing

- /api/v1 is **purely additive**. Every existing unversioned route keeps working with byte-identical behaviour. A parity test proves it (§5.3).
- Do not refactor the 18 public handlers to add v1. Re-export them.
- Do not change existing MCP tool names, schemas, or the fail-closed approval default.

### 2.5 Process

- **Never push to main.** Branch + PR per phase, per the branch names in §0.
- **Verify by execution before claiming done** — see §12.
- **Pause and ask the founder** at every gate in §10. Do not self-authorise a publish, a public exposure, or a migration.
- If a fact you need is in §11, **verify it against the vendor's live documentation** before coding. Do not guess a config path; a wrong path silently does nothing, which is the worst possible failure mode for an installer.

## 3. Agent Registry — Data Specification

This is the single source of truth for the whole program. Get this right and the installer, docs, rules files, in-app snippets and conformance tests all fall out of it. Get it wrong and 15 integrations silently break.

### 3.1 Install strategy — be honest that it is not 15/15 file writes

Three of the 15 agents have **no writable config file path we can currently target**, and a further three have paths the docs do not state. A CLI that claims to have configured all 15 would be lying. The registry therefore carries an explicit discriminator:

| Strategy      | Meaning                                                          | Agents                                                                                                                                 |
| ------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| config-file   | CLI parses, merges and writes a real file                        | Cursor, Windsurf, VS Code, OpenAI Codex, OpenCode, Kilo Code, Zed, Gemini CLI, Claude Code (.mcp.json), PiCode\*, OpenClaw\*, Hermes\* |
| vendor-cli    | The sanctioned path is the vendor's own CLI; shell out to it     | Amp (amp mcp add) — only option. Claude Code (claude mcp add) — global alternative to the file.                                        |
| guided-manual | No file or CLI available; print exact values + copy to clipboard | JetBrains AI & Junie (Settings UI only)                                                                                                |

\* path not stated in our docs → **§11 must-verify** before shipping the writer for it. Until verified, these three degrade to guided-manual. Shipping a writer against a guessed path is worse than not shipping one, because a wrong path fails silently.

### 3.2 Type definition

```ts
// packages/agent-registry/src/types.ts
export type ConfigFormat = "json" | "jsonc" | "toml" | "yaml"
export type InstallStrategy = "config-file" | "vendor-cli" | "guided-manual"
export type Transport = "stdio" | "remote-http"
export type CredentialStyle =
  | { kind: "inline-env" } // env: { KEY: "lsk_..." }
  | { kind: "interpolated-env"; syntax: string } // env: { KEY: "{env:KEY}" }
  | { kind: "env-names"; field: string } // Codex: env_vars sub-table
  | { kind: "shell-env" } // Amp: inherit from shell only
  | { kind: "http-header"; header: string } // Authorization: Bearer
  | { kind: "ui-fields" } // JetBrains

export interface ConfigLocation {
  scope: "project" | "global"
  /** POSIX-style, ~ allowed. Per-OS overrides in platform. */
  path: string
  platform?: Partial<Record<"darwin" | "linux" | "win32", string>>
  /** True when this file is commonly committed -> NEVER inline a secret (§2.1). */
  sharedByConvention: boolean
}

export interface AgentEntry {
  id: string // stable slug, matches docs URL
  displayName: string
  docsSlug: string // /docs/integrations/<slug>
  installStrategy: InstallStrategy
  format: ConfigFormat | null
  /** THE critical field. Differs per agent; a wrong value fails silently. */
  rootKey: string | null
  locations: ConfigLocation[]
  transports: Transport[]
  credential: CredentialStyle
  /** Extra fields the entry must carry, e.g. { type: "stdio" } for VS Code. */
  requiredEntryFields?: Record<string, string>
  /** Nest command/args/env inside this key (Zed). */
  commandWrapperKey?: string | null
  vendorCli?: { command: string; args: string[] }
  rulesFiles: string[] // drives PR 2
  serverNameConstraint?: string // e.g. Gemini: no underscores
  gotchas: string[] // surfaced verbatim by lyrashield doctor
}
```

### 3.3 The 15 entries — verbatim from the shipped docs

Values below were extracted from apps/marketing/src/pages/docs/integrations/*.astro at cef548d. **Treat them as authoritative for what we currently publish, and cross-check against vendor docs for what is currently true (§11).**

| #   | id           | Format    | **Root key**        | Path(s)                                                        | Credential                       | Strategy                 |
| --- | ------------ | --------- | ------------------- | -------------------------------------------------------------- | -------------------------------- | ------------------------ |
| 1   | claude-code  | json      | mcpServers          | proj .mcp.json **(shared!)**                                   | inline-env                       | config-file + vendor-cli |
| 2   | cursor       | json      | mcpServers          | proj .cursor/mcp.json **(shared!)**; global ~/.cursor/mcp.json | inline-env                       | config-file              |
| 3   | windsurf     | json      | mcpServers          | global ~/.codeium/windsurf/mcp_config.json                     | inline-env / header              | config-file              |
| 4   | vscode       | json      | **servers**         | proj .vscode/mcp.json **(shared!)**; global user settings.json | inline-env                       | config-file              |
| 5   | openai-codex | toml      | **mcp_servers**     | global ~/.codex/config.toml                                    | **env_vars** table               | config-file              |
| 6   | cline        | json      | mcpServers          | cline_mcp_settings.json (path via panel — verify)              | inline-env / header              | config-file\*            |
| 7   | opencode     | json      | **mcp**             | proj opencode.json **(shared!)**                               | {env:VAR}                        | config-file              |
| 8   | kilo-code    | **jsonc** | **mcp**             | proj kilo.jsonc **(shared!)**                                  | {env:VAR}                        | config-file              |
| 9   | zed          | json      | **context_servers** | global user settings.json                                      | inline-env **nested in command** | config-file              |
| 10  | gemini-cli   | json      | mcpServers          | global ~/.gemini/settings.json                                 | inline-env (**mandatory**)       | config-file              |
| 11  | jetbrains    | —         | —                   | Settings → Tools → AI Assistant → MCP Servers                  | ui-fields                        | **guided-manual**        |
| 12  | amp          | —         | —                   | none (global, CLI-managed)                                     | shell-env                        | **vendor-cli**           |
| 13  | picode       | json      | mcpServers          | **path not documented**                                        | inline-env                       | verify → config-file     |
| 14  | openclaw     | yaml      | mcp_servers         | mcporter.yaml / profile YAML                                   | inline-env                       | verify → config-file     |
| 15  | hermes       | yaml      | mcp_servers         | profile YAML (path not documented)                             | inline-env                       | verify → config-file     |

### 3.4 The gotchas that will bite you — encode every one as a test

These are real, documented, silent-failure traps. Each must appear in gotchas[] **and** have a conformance assertion (§5.7).

1. **VS Code uses servers, not mcpServers.** Using mcpServers **silently fails**. Entries also require "type": "stdio".
2. **Zed uses context_servers**, and nests args/env **inside a command object** whose executable field is **path**, not command:
   { "context_servers": { "lyrashield": { "command": { "path": "npx", "args": [...], "env": {...} } } } }
3. **OpenAI Codex uses env_vars, not env** — a separate TOML sub-table [mcp_servers.lyrashield.env_vars]. Using env is **silently ignored**.
4. **OpenCode and Kilo Code use single-brace {env:VAR}**, not ${VAR}. Wrong syntax passes the literal string through. Both also need "type": "local" or "remote".
5. **Gemini CLI strips env vars whose names contain KEY, TOKEN or SECRET** from subprocess environments. LYRASHIELD_API_KEY **must** be declared inline in the entry's env block — shell inheritance does not work. Additionally: **no underscores in the server name** (lyrashield, never lyra_shield).
6. **Cline defaults to legacy SSE** when type is omitted. The remote endpoint requires "type": "streamableHttp" explicitly.
7. **Windsurf's remote form uses serverUrl**, not url.
8. **Kilo Code's file is JSONC.** A JSON.parse/stringify round-trip destroys the user's comments (§2.2).
9. **Amp takes no --env flags.** The key must be exported in the user's shell profile; Amp config is global with no per-project file. Verify with amp mcp list.
10. **JetBrains has no file we can write.** Print the exact Command / Arguments / Env values and the settings path.
11. **OpenClaw and Hermes declare transport: stdio explicitly** in YAML, unlike the JSON agents.

### 3.5 Canonical values

- npm package invoked by every stdio config: npx -y @lyrashield/mcp (published, v0.2.0).
- Server name everywhere: **lyrashield** (no underscores — gotcha 5).
- Remote endpoint: https://app.lyrashieldai.com/api/mcp, auth Authorization: Bearer lsk_…, Streamable HTTP.
- Env vars: LYRASHIELD_API_KEY (lsk_ + 43 base64url chars, 47 total), LYRASHIELD_API_URL.
- Cloud platforms on the remote endpoint: **Lovable** (Settings → Integrations → Custom MCP), **Bolt.new** hosted (Settings → MCP Servers; Bolt Desktop can use stdio), **Replit** (Tools → MCP Servers), **v0** (Settings → Integrations → MCP).
- ⚠️ **Default API URL inconsistency:** packages/mcp defaults LYRASHIELD_API_URL to http://localhost:3000, while every docs page shows https://app.lyrashieldai.com. **The CLI must default to the production URL**, and doctor should flag a localhost value as probably-wrong outside development.

## 4. Architecture Decisions & Rationale

Decisions are recorded with their reasoning so you can push back with evidence rather than preference.

### 4.1 /api/v1 + OpenAPI must land before the CLI — the one-way door

The API is unversioned today (/api/scans, /api/findings). If the CLI and SDK ship against those paths, they get baked into every user's machine and every third-party integration. Versioning afterwards then means either breaking our own published CLI or maintaining unversioned paths as a public contract forever.

Versioning first costs a day. Versioning later costs a breaking change to shipped software. **This is the only ordering constraint in the program that cannot be relaxed.**

### 4.2 /api/v1 is a curated surface, not a blanket rewrite

Do **not** implement v1 as a next.config rewrite of /api/v1/* → /api/*. That would expose DELETE /api/account, onboarding state, notification preferences and referral endpoints as public versioned API — a surface we would then be obliged to support, and an attack surface we did not intend.

Instead: create **explicit re-export route files** for the curated public set only (§5.3). The absence of a v1 route is a deliberate statement that the endpoint is internal.

### 4.3 One registry generates five surfaces

Fifteen agents × five surfaces (config writer, docs page, rules file, in-app snippet, conformance fixture) is 75 hand-maintained artifacts. They will drift within weeks, and drift in an installer is silent — a stale root key produces no error, just an integration that quietly does nothing.

So: packages/agent-registry is the only place any per-agent fact lives. The CLI reads it, the docs pages are generated from it, the rules files are rendered from it, the in-app connect UI consumes it, and the conformance suite asserts against it. **Adding agent #16 must be one registry entry plus a fixture — nothing else.** If your implementation requires touching five files to add an agent, the abstraction has failed.

### 4.4 The installer inherits the scanner's honesty discipline

docs/vibe-security-50.md forbids reporting passed or clean merely because nothing came back, and defines DETECTED / NO_FINDING / INCONCLUSIVE / NOT_APPLICABLE / EVIDENCE_REQUIRED instead. The installer must hold the same line, because the same failure mode exists: writing a file is not proof the agent loaded it.

lyrashield init reports per agent, and must never claim more than it did:

| Outcome            | Meaning                                                              |
| ------------------ | -------------------------------------------------------------------- |
| CONFIGURED         | File written/merged and re-parsed successfully                       |
| ALREADY_CONFIGURED | Correct entry already present; nothing changed                       |
| DELEGATED          | Vendor CLI invoked and exited 0 (Amp, claude mcp add)                |
| MANUAL_REQUIRED    | No writable path; exact values printed (JetBrains, unverified paths) |
| NOT_DETECTED       | No sign of this agent on the machine; skipped                        |
| FAILED             | Attempted and failed; reason + backup path printed                   |

**CONFIGURED must never mean "we wrote a file and hope."** It means: written, re-read, and the lyrashield entry found at the expected root key. It still does not mean the agent has loaded it — say so in the summary and point at lyrashield doctor.

### 4.5 One shared client so the CLI and MCP cannot diverge

packages/mcp/src/tools.ts already contains a private apiCall helper implementing the { success, data, error } envelope, Bearer auth and a 30s abort timeout. If the CLI writes its own HTTP layer, the two will drift in error handling, retry and timeout behaviour — and the CLI will start reporting different results from the MCP tool for the same request, which is a trust bug in a trust product.

Extract it into **packages/sdk** (@lyrashield/sdk) and have both consume it. packages/mcp's tool handlers keep their signatures; only the transport underneath changes.

### 4.6 Known hazard — zod major-version split

Verified across the workspace:

- packages/types, apps/web, apps/worker, apps/agent, apps/marketing, packages/config → **zod ^4**
- packages/mcp → **zod ^3.25.76**

Consequences for PR 1:

- **OpenAPI generation is easy on zod 4**: use the built-in z.toJSONSchema() on the schemas in packages/types/src/index.ts. Do **not** add zod-to-openapi or zod-to-json-schema (neither is currently a dependency, and neither is needed for zod 4).
- **Do not force zod on packages/mcp.** Its MCP tools declare inputSchema as plain JSON-Schema objects, not zod — so the SDK must not re-export zod schemas into MCP's runtime, or you will pull zod 4 into a zod 3 package. Keep @lyrashield/sdk's public surface plain TypeScript types + JSON, with zod validation optional and internal.
- Record the divergence; propose aligning packages/mcp to zod 4 as a **separate** follow-up PR. Do not bundle a zod major bump into PR 1.

### 4.7 Build conventions to match (verified)

- pnpm workspaces: apps/_, packages/_. Package manager pnpm@11.6.0, Node >=20.
- New library packages extend packages/config/tsconfig/library.json, with a separate tsconfig.build.json (composite: false, declaration: true, noEmit: false) exactly as packages/mcp does.
- Publishable packages bundle with tsup: format: ["esm"], target: "node20", noExternal: [/^@lyrashield\//] (workspace deps are unpublished and **must** be bundled), real deps external, banner: { js: "#!/usr/bin/env node" } for bins.
- Turbo tasks available: build (outputs dist/**), lint, typecheck, dev. build/lint/typecheck all dependsOn: ["^build"].
- Tests: root vitest (v4) via pnpm test; packages/mcp pins vitest ^3.2.7 locally. New packages should use the root runner unless there is a reason not to.
- Any new env var must be added to turbo.json's globalEnv or Turbo will not pass it through.

## 5. PR 1 — Implementation Tasks (5.1–5.4: Registry, Installers, API v1, SDK)

Branch: feat/agent-registry-and-cli. Build in this order — each step is a dependency of the next.

### 5.1 packages/agent-registry

New package @lyrashield/agent-registry. Internal (not published), so it is bundled into consumers via noExternal.

**Files:**

- src/types.ts — the types in §3.2, verbatim.
- src/agents/<id>.ts — one file per agent, 15 total. One file per agent (not one big array) keeps diffs readable and makes ownership obvious.
- src/index.ts — export const AGENTS: readonly AgentEntry[], plus getAgent(id), listAgents(), agentsByStrategy(s).
- src/render.ts — pure functions that turn (AgentEntry, InstallOptions) into config content. **Pure and side-effect free** — no filesystem access. This is what makes them trivially testable and reusable by docs generation and the in-app snippet UI.
- src/schema.ts — a zod (v4) schema validating registry entries, run as a unit test so a malformed entry fails CI.

**Renderer contract:**

```ts
type InstallOptions = {
  transport: Transport
  apiUrl: string
  secretMode: "inline" | "interpolated" | "shell" | "header"
  apiKey?: string          // only read when secretMode === "inline"
  serverName?: string      // default "lyrashield"
}
// Returns the full file content for a fresh file...
renderConfig(agent, opts): { content: string; format: ConfigFormat }
// ...and a structural patch for merging into an existing file.
renderEntry(agent, opts): { rootKey: string; entryKey: string; value: unknown }
```

renderEntry is what the merge path uses (§5.2); renderConfig is for docs, the in-app snippet, and greenfield files. Both must come from the same underlying builder so a docs snippet can never disagree with what the CLI writes.

**Acceptance:** a table-driven test renders every agent × every supported transport and snapshots the output. 15 entries validate against src/schema.ts. Every gotcha in §3.4 has a named assertion.

### 5.2 Per-agent installer semantics

Lives in packages/cli/src/installers/, driven entirely by the registry — **no per-agent if branches in command code.** Dispatch on format for writing and on installStrategy for the overall path.

**Format writers** (one per format, not one per agent):

- json.ts — read, JSON.parse, set [rootKey][serverName], write with the file's detected indentation.
- jsonc.ts — **must preserve comments.** Use jsonc-parser's modify() + applyEdits() (surgical text edits), never parse-and-restringify. Kilo Code only.
- toml.ts — must preserve unrelated tables and comments in ~/.codex/config.toml. Use a format-preserving TOML editor. Remember env_vars is a **sub-table**, not an inline key (gotcha 3).
- yaml.ts — comment-preserving YAML (e.g. the yaml package's Document API) for OpenClaw/Hermes. Emit transport: stdio explicitly (gotcha 11).

**Secret mode resolution** — implement exactly this precedence, it is the §2.1 guardrail in code:

1. Agent supports interpolation (opencode, kilo-code) → interpolated. Never inline.
2. Agent is shell-env (amp) → shell. Ensure/instruct the shell export.
3. Target location has sharedByConvention: true → interpolated if supported, else **MANUAL_REQUIRED unless --inline-secret is passed**. With the flag: warn, and if the file is git-tracked and not gitignored, **refuse**.
4. Location is global and not shared → inline is allowed. chmod 0600 after write.
5. gemini-cli → inline is **mandatory** even though it feels wrong (gotcha 5); its file is global, so this is safe.

**Every write, without exception:** resolve path (with platform override) → detect existence → backup to <file>.lyrashield-backup-<ISO8601> → merge via format writer → write atomically (temp file + rename) → **re-read and assert the entry is present at the expected root key** → report an outcome from §4.4.

**Detection** (NOT_DETECTED vs MANUAL_REQUIRED): presence of the config file, its parent directory, or the vendor binary on PATH. Detection must never be destructive and must never create a directory for an agent the user does not have.

### 5.3 /api/v1 — curated, additive, parity-tested

Create apps/web/src/app/api/v1/**/route.ts files that **re-export the existing handlers**:

```ts
// apps/web/src/app/api/v1/scans/route.ts
export { GET, POST } from "../../scans/route"
```

Dynamic routes re-export identically (the (req, ctx) signature is unchanged). If a re-export ever misbehaves under the App Router, fall back to a thin wrapper that calls the original handler — **do not refactor the handler itself.**

**The curated v1 set** (18 routes — everything an external CLI/SDK/agent legitimately needs):

scans (GET, POST) · scans/[id] (GET, POST=cancel) · findings (GET) · findings/[id] (GET, PATCH) · findings/[id]/fix-proposals (POST) · findings/[id]/retests (POST) · targets (GET, POST) · fix-proposals (GET) · fix-proposals/[id]/create-pr (POST) · retests (GET) · reports (GET, POST) · reports/[id] (GET, POST) · reports/[id]/download (GET) · launch-readiness (GET) · workspaces (GET, POST) · schedules (GET, POST) · schedules/[id] (GET, PATCH, DELETE) · projects (GET, POST)

**Deliberately excluded from v1** — do not add these without a founder decision: account, team, notifications*, onboarding, referrals/_, scorecards/_, targets/[id]/scorecard, api-keys* (session-only by design — API keys must not mint keys), auth/_, health, ready_, lite-scan, lite-scorecards, mcp, webhooks/github, integrations/github/*.

**agent-approvals is a judgement call.** A CI agent legitimately needs it, but PR 3 changes its semantics. **Leave it out of v1 in PR 1**; add it in PR 3 once the remote approval flow is settled, so we version it correctly the first time.

**Parity test (required, §2.4):** for every v1 route, assert the v1 module's exported HTTP methods are referentially identical to the unversioned module's. Cheap, and it catches a re-export that silently drops PATCH.

**Note — fix-proposals/[id]/create-pr always returns 409 PROPOSAL_PATCH_REQUIRED** today; the PR pipeline is unimplemented and fails closed. Expose it in v1 and document the 409 honestly in OpenAPI. Do not implement PR creation in this PR.

### 5.4 packages/sdk — @lyrashield/sdk

Extract the private apiCall from packages/mcp/src/tools.ts into a real client. Publishable, ESM, zod-4-free public surface (§4.6).

**Must preserve, exactly:** the { success, data, error: { code, message } } envelope; Authorization: Bearer <key>; Content-Type: application/json; a 30s AbortController timeout; and error precedence — prefer error.message from the JSON body, fall back to ${status} ${statusText}, and treat success: false as an error even on HTTP 200.

**Add, because the CLI needs it and MCP benefits:**

- **All paths prefixed /api/v1.** The SDK never calls an unversioned path.
- Cursor pagination helper — { cursor, limit } in, { items, nextCursor } out, plus an async iterator that walks pages. Limit is 1–100, default 50.
- ETag / If-None-Match support for GET /api/v1/scans and /scans/[id] (the only two routes that implement it) so scan --watch polling is cheap. A 304 must surface as "unchanged", not an error.
- Typed error class carrying status + code so the CLI can map SCAN_CONCURRENCY_LIMIT, SCAN_RATE_LIMITED, RETEST_IN_PROGRESS etc. to useful exit codes and messages.
- Honour Retry-After on 429 (the API always sets it). Bounded retry with jitter on 429/503 only — **never retry a non-idempotent POST** such as scan creation.

**Then rewire packages/mcp to consume it**, keeping all 14 tool names, descriptions, inputSchema objects and mutating flags byte-identical. packages/mcp tests must pass unchanged — that is the proof the refactor is behaviour-preserving.

**Rate limits to respect and surface:** scan creation is **5 per workspace per minute** (checkScanCreateRateLimit), returning 429 + Retry-After. The CLI must print the retry window rather than looping.

## 5. PR 1 — Implementation Tasks (5.5–5.8: OpenAPI, CLI, Conformance, Docs)

### 5.5 OpenAPI 3.1 spec

Generate from the zod schemas that already exist in packages/types/src/index.ts — do not hand-write it, or it will be wrong within a month.

- Use zod 4's built-in **z.toJSONSchema()** (§4.6). No new dependency.
- Source schemas already present: CreateScanSchema, ScanStatusSchema, ScanGoalSchema, ScanModeSchema, FindingSeveritySchema, FindingStatusSchema, CreateWorkspaceSchema, CreateRepoTargetSchema, CreateUrlTargetSchema, CreateProjectSchema, CreateReportSchema, ReportActionSchema, CreateFixProposalSchema, CreateRetestSchema, PatchFindingSchema, CreateScheduleSchema, PatchScheduleSchema, FindingQuerySchema, CreatePRSchema.
- Model the shared envelopes once as components and reference them: success { success: true, data: T }; error { success: false, error: { code, message } }; paginated { success: true, data: { items: T[], nextCursor: string|null, total?: number } }.
- Document the real status codes: 200, 201, 304 (scans list/detail only), 400, 401, 403, 404, 409, 422, 429 (+ Retry-After), 500, 503.
- securitySchemes: HTTP bearer, lsk_ workspace API key. Document the two scopes (read, write) and that write-scope is required for anything outside the read allowlist (scan:view, finding:view, retest:view, notification:view, schedule:view, audit:view, agent:view, report:download).
- **Document workspaceId as a required parameter on essentially every endpoint** — it is caller-supplied, not inferred from the key, and a key bound to workspace A is rejected for workspace B. This is the single most surprising thing about the API for an integrator.
- Serve at /api/v1/openapi.json (public, no auth — it is a schema, not data) and render human docs at /docs/api on the marketing site.
- **Test:** the generated spec validates against the OpenAPI 3.1 meta-schema, and a test asserts every route in the §5.3 curated list appears in it. A route in v1 but missing from the spec is a bug.
- Write docs/api-stability.md: v1 is additive-only; breaking changes require v2; deprecations get a minimum notice window (propose 90 days for founder confirmation).

### 5.6 packages/cli — the lyrashield binary

Publishable. **bin: { lyrashield: "./dist/index.js" }.** Published twice per founder decision §1.3.1: unscoped **lyrashield** (primary) and **@lyrashield/cli** (alias — same bin, its README pointing at the primary name).

Use a small, well-maintained arg parser and keep startup fast — this runs in pre-commit hooks. No heavyweight framework.

**Command surface:**

| Command                             | Purpose                                                                                                                                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| init                                | Detect installed agents, configure each. --dry-run, --agent <id> (repeatable), --all, --global/--project, --transport stdio\|remote, --inline-secret, --yes                                        |
| install <agent> / uninstall <agent> | Single agent. uninstall removes only our entry, leaving the rest of the file untouched                                                                                                             |
| login / logout                      | Store/clear the key per §2.3. Accept --key, or read stdin so it never lands in shell history                                                                                                       |
| use <workspace>                     | Set default workspace (required — workspaceId is caller-supplied on every route)                                                                                                                   |
| agents                              | List registry agents with detection state and configured state                                                                                                                                     |
| scan                                | Start a scan. --target <id>, --goal CHECK_PR\|TEST_APP\|LAUNCH_REVIEW\|WEEKLY_MONITOR\|FULL_PENTEST\|COMPLIANCE_REVIEW, --mode SAFE\|QUICK\|STANDARD\|DEEP\|CUSTOM (default SAFE), --watch, --json |
| status [scanId]                     | Scan status + events; --watch uses ETag polling                                                                                                                                                    |
| findings                            | --severity, --status, --target, --scan, --verified, --stats, --json                                                                                                                                |
| explain <findingId>                 | Detail + plain-language explanation                                                                                                                                                                |
| fix-plan <findingId>                | Remediation plan                                                                                                                                                                                   |
| verify <findingId>                  | Queue a retest                                                                                                                                                                                     |
| check-diff                          | Local advisory heuristic on the diff. --staged, --base <ref>. **Not a scan — label it as advisory in output**                                                                                      |
| hook install                        | Install a pre-commit hook calling check-diff --staged                                                                                                                                              |
| gate                                | CI gate. --fail-on CRITICAL\|HIGH\|MEDIUM\|LOW\|INFO (default HIGH), --sarif <path>. Semantics must match action.yml                                                                               |
| report                              | Create/list/download reports                                                                                                                                                                       |
| readiness                           | Launch readiness verdict (GO / GO_WITH_CONDITIONS / NO_GO)                                                                                                                                         |
| targets                             | List/create targets                                                                                                                                                                                |
| rules add <agent>                   | Write the agent's rules file (**stub in PR 1, implemented in PR 2**)                                                                                                                               |
| doctor                              | Diagnose: key present/valid, API reachable, workspace resolvable, per-agent config found at the correct root key, plus the agent's gotchas[]                                                       |

**doctor is the highest-value command in the CLI.** Every gotcha in §3.4 is a silent failure; doctor is the only thing that converts silence into a message. Give it real effort — it should detect a config written under the wrong root key (e.g. mcpServers in a VS Code file) and say exactly that.

**Requirements:**

- --json on every read command, machine-readable and stable — agents will parse it.
- Exit codes: 0 ok · 1 findings at/above threshold (gate) · 2 usage error · 3 auth error · 4 network/API error · 5 rate limited. Document them.
- Non-TTY aware: no spinners or colour when piped; respect NO_COLOR.
- **Never print a key.** Redact to lsk_… + last 4 everywhere, including doctor and --dry-run.
- LYRASHIELD_API_KEY / LYRASHIELD_API_URL from the environment always win over stored config, so CI needs no state.

### 5.7 Conformance suite — the anti-drift mechanism

packages/agent-registry/src/**tests**/conformance/. This is what stops a vendor's rename from silently breaking users.

1. **Vendor schema fixtures** — one committed fixture per agent representing that vendor's expected config shape, with a comment recording the source URL and the date checked.
2. **Round-trip assertions** — for every agent: render → parse with that format's parser → assert the entry sits at the expected rootKey with the expected shape. Catches gotchas 1, 2, 3, 4, 6, 7, 11 by construction.
3. **Merge-safety assertions** — start from a fixture containing _another vendor's_ MCP server plus unrelated settings; after install, assert the foreign server and unrelated keys are byte-identical and only our entry was added. Include a JSONC fixture **with comments** and assert the comments survive (gotcha 8).
4. **Idempotency** — install twice, assert the second write is a no-op and reports ALREADY_CONFIGURED.
5. **Uninstall cleanliness** — install then uninstall, assert the file returns to its original bytes.
6. **Secret-leak assertions** — the most important tests here. Assert that rendering for any location with sharedByConvention: true **never** contains a literal lsk_ value unless --inline-secret was explicitly passed; and that a git-tracked, non-gitignored shared file **refuses** even with the flag.
7. **Docs/registry consistency** — assert every generated docs page's snippet is byte-identical to renderConfig() output for that agent, so published instructions cannot drift from installer behaviour.
8. **Snapshot tests** on all rendered configs, so any change to any agent's emitted output is a visible, reviewed diff.

### 5.8 Regenerate the 15 docs pages from the registry

The pages under apps/marketing/src/pages/docs/integrations/ currently hard-code their snippets. Convert them so the code blocks come from renderConfig().

- Keep every page's existing URL, prose, updatedDate, JSON-LD and DocsLayout usage. **This is a snippet-source change, not a redesign** — the pages have SEO value and an FAQPage schema that should not churn.
- Generate the index.astro nav-card grid from listAgents() so a new agent appears automatically.
- Surface installStrategy honestly on each page: for JetBrains say plainly that config is UI-only; for Amp that it is CLI-only and global.
- Add the one-line install to every page: npx lyrashield install <agent> — but **only after the founder approves the npm publish (§10)**. Until then, generate it behind a flag that renders the manual instructions, so the docs never promise a command that does not exist yet.
- Add a /docs/api page rendering the OpenAPI spec.
- The existing troubleshooting.astro should be regenerated from the registry's gotchas[] so it stays complete as agents are added.

## 6. PR 1 — File Manifest & Order of Work

### 6.1 Order of work

Do it in this sequence. Each step is verifiable on its own, so a failure is localised rather than discovered at the end.

1. **Registry package** (§5.1) — types, 15 entries, renderers, schema test. Verify: pnpm --filter @lyrashield/agent-registry test green, snapshots reviewed by eye against §3.3/§3.4.
2. **Conformance suite** (§5.7) — write it _now_, against the registry, before the CLI exists. It is a spec for the installers, and writing it first stops you from encoding a bug in both places.
3. **/api/v1** (§5.3) + parity test. Verify: pnpm --filter @lyrashield/web typecheck and the parity test green; spot-check one v1 route against its unversioned twin at runtime.
4. **OpenAPI** (§5.5). Verify: spec validates; coverage test green.
5. **SDK** (§5.4), then rewire packages/mcp onto it. Verify: **packages/mcp's existing tests pass unchanged** — that is the behaviour-preservation proof.
6. **CLI** (§5.6) — login/use/agents/doctor first (they make everything else debuggable), then init/install/uninstall, then the scan/finding commands, then gate and hook.
7. **Regenerate docs** (§5.8). Verify: pnpm --filter @lyrashield/marketing build green; docs/registry consistency test green.
8. **Full-repo verification** (§9), then open the PR.

Do **not** publish anything to npm in this PR. Publishing is a separate, founder-gated step (§10).

### 6.2 New files

```
packages/agent-registry/
  package.json  tsconfig.json  tsconfig.build.json
  src/types.ts  src/index.ts  src/render.ts  src/schema.ts
  src/agents/{claude-code,cursor,windsurf,vscode,openai-codex,cline,
              opencode,kilo-code,zed,gemini-cli,jetbrains,amp,
              picode,openclaw,hermes}.ts
  src/__tests__/registry.test.ts
  src/__tests__/conformance/*.test.ts
  src/__tests__/fixtures/<agent>/*         # vendor shape + "existing file" fixtures

packages/sdk/
  package.json  tsconfig.json  tsconfig.build.json  tsup.config.ts
  src/index.ts  src/client.ts  src/errors.ts  src/pagination.ts
  src/resources/{scans,findings,targets,reports,fix-proposals,
                 retests,schedules,projects,workspaces,launch-readiness}.ts
  src/__tests__/*.test.ts

packages/cli/
  package.json  tsconfig.json  tsconfig.build.json  tsup.config.ts  README.md
  src/index.ts                    # bin entry
  src/commands/*.ts               # one per command (§5.6)
  src/installers/{json,jsonc,toml,yaml}.ts
  src/installers/{detect,backup,merge,secret-mode}.ts
  src/credentials.ts              # ~/.lyrashield/credentials.json, 0600
  src/output.ts                   # TTY/JSON/NO_COLOR handling, key redaction
  src/__tests__/*.test.ts

packages/cli-alias/                # thin @lyrashield/cli that re-exports the bin
  package.json  README.md

apps/web/src/app/api/v1/**/route.ts        # 18 curated re-export routes (§5.3)
apps/web/src/app/api/v1/openapi.json/route.ts
apps/web/src/lib/openapi/{build,components}.ts
apps/web/src/__tests__/api-v1-parity.test.ts

apps/marketing/src/pages/docs/api.astro
docs/api-stability.md
docs/agent-integrations.md          # how to add agent #16 — one entry + one fixture
```

### 6.3 Modified files

```
pnpm-workspace.yaml                 # no change needed (packages/* already globbed)
turbo.json                          # add any new env vars to globalEnv
packages/mcp/src/tools.ts           # swap private apiCall -> @lyrashield/sdk
packages/mcp/package.json           # add @lyrashield/sdk workspace dep
apps/marketing/src/pages/docs/integrations/*.astro   # 15 pages + index + troubleshooting:
                                    # snippets now sourced from renderConfig()
```

### 6.4 Explicitly not touched in PR 1

- packages/db/prisma/schema.prisma — **no migration in PR 1–3** (founder decision §1.3.3).
- action.yml — the GitHub Action stays as-is; the CLI's gate matches its semantics rather than replacing it.
- Existing unversioned /api/* routes — additive only (§2.4).
- MCP tool names, descriptions, inputSchema objects, mutating flags, and the fail-closed approval default.
- buildScorecardPayload and the public scorecard allowlist — nothing in PR 1–3 touches the public score surface.

## 7. PR 2 — Rules, Skills & Plugins

Branch: feat/agent-rules-and-skills. Depends on PR 1's registry.

This is the layer that makes the integration _behavioural_ rather than merely _available_. Installing the MCP server gives an agent the tools; the rules file is what makes it actually run check_diff before opening a PR without being asked.

### 7.1 One canonical policy, many renderings

Today agent-rules.astro ships three hand-written snippets (CLAUDE.md, AGENTS.md, .cursorrules) with overlapping but non-identical wording. Maintaining 15 divergent texts is how policy drift happens.

Create packages/agent-rules with **one canonical policy** as structured data, plus per-format renderers. The canonical policy is derived from the three shipped snippets — their existing content is good and founder-visible, so preserve its substance and its honesty:

- **Pre-PR:** run check_diff on staged changes; review findings before committing; address them or document why each is acceptable.
- **Post-fix:** after applying a fix, run verify_fix with the finding ID; include the verification receipt in the PR description.
- **Scope limits:** only scan targets owned by this workspace and listed as authorised; never scan third-party URLs without explicit authorisation.
- **Honesty clause (keep this verbatim in spirit):** _"A clean check result does not guarantee the absence of all vulnerabilities."_ / _"A passing check is not a guarantee of zero vulnerabilities."_ This sentence must survive every rendering — it is the same discipline as §4.4 and it is what keeps the product honest inside someone else's agent.

### 7.2 Per-agent targets

Drive these from AgentEntry.rulesFiles so the set is registry-declared, not hard-coded:

| Format      | File                                                                              | Agents                                                         |
| ----------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Claude Code | CLAUDE.md section **+ plugin** (skills, slash commands, hook)                     | claude-code                                                    |
| AGENTS.md   | AGENTS.md — the emerging cross-vendor standard                                    | openai-codex, jetbrains (Junie), hermes, opencode, amp, zed \* |
| Cursor      | .cursor/rules/lyrashield.mdc with globs (modern form) **and** legacy .cursorrules | cursor                                                         |
| Copilot     | .github/copilot-instructions.md                                                   | vscode                                                         |
| Windsurf    | .windsurf/rules/ + a workflow                                                     | windsurf                                                       |
| Cline       | .clinerules                                                                       | cline                                                          |
| OpenClaw    | skill.md in the skills dir — a real snippet already exists in our docs            | openclaw                                                       |

\* Verify per-vendor which of these actually read AGENTS.md before claiming it (§11). Our docs currently assert it for Codex, Junie and Hermes only.

**Claude Code deserves the most investment** — it supports the richest surface (plugin + SKILL.md skills + slash commands + PreToolUse hooks), and a hook that runs check-diff --staged before a commit is the single highest-leverage thing in this PR: it makes the security check automatic rather than advisory.

### 7.3 Managed-block discipline

Rules files belong to the user. We are a guest in them.

- Write inside delimited, checksummed markers:
  <!-- lyrashield:begin v=<policyVersion> sha=<sha256-12> --> … <!-- lyrashield:end -->
- On re-run: if the checksum matches, no-op. If the user edited inside the block, **do not overwrite** — report the divergence and require --force.
- lyrashield rules add <agent> / rules remove <agent> / rules check, with --dry-run, and the same backup discipline as §2.2.
- Never write a rules file into a repo the user did not ask about, and never outside the current project root.

### 7.4 Self-consistency — our rules must pass our own scanner

**This is the section not to skip.** apps/worker/src/engine/scanners/agent-config-scanner.ts scans exactly the files we are about to write — AGENTS.md, CLAUDE.md, .cursorrules, .windsurfrules, .github/copilot-instructions.md — and flags clauses matching DANGEROUS_INSTRUCTION_PATTERNS, with a PROTECTIVE_INSTRUCTION_PATTERNS allowlist.

If LyraShield's own emitted rules trip LyraShield's own scanner, that is both a legitimate finding and an embarrassing one.

Required:

1. **Write least-privilege rules.** No instruction that broadens agent permissions, disables checks, auto-approves actions, or tells the agent to skip review. Our policy tells an agent to run _more_ checks, never fewer.
2. **Add a test that runs scanAgentConfig over every rendered rules file** and asserts zero dangerous-instruction findings. This test is the contract. Run it for all 15 agents × all rules formats.
3. **Teach the scanner to recognise our managed block** — extend PROTECTIVE_INSTRUCTION_PATTERNS (or add explicit managed-block handling) so a checksum-valid LyraShield block is understood as protective. Be careful: this must key on the checksummed markers, **not** on a bare string like "LyraShield", or an attacker gets a trivial allowlist bypass by naming their malicious block after us. Treat this as a security-critical change and call it out in the PR description.
4. **Ship the story.** "We scan agent instruction files — including our own, in CI" is a genuinely differentiated trust claim, and unlike most such claims it will be true and testable. Flag it to the Marketing Agent as a dev-verified fact.

## 8. PR 3 — Remote Out-of-Band Approval (unlocks cloud agents)

Branch: feat/remote-mcp-approval. **Security-critical — this touches an approval gate. Founder heads-up before merge (§10).**

### 8.1 The problem

/api/mcp correctly refuses mutating tools over remote transport, because a stateless HTTP request has no channel to prompt a human. Our own docs say so: _"Remote mutating tools (scan triggers, finding submissions) are refused unless a trusted automation explicitly opts in."_

The consequence is that every cloud agent — Lovable, Bolt.new hosted, Replit, v0 — can read findings but can never start a scan or record a fix. Half the loop is unavailable to exactly the audience (vibe coders on hosted platforms) that the product's editorial strategy targets.

The current escape hatch is LYRASHIELD_MCP_ALLOW_REMOTE_MUTATIONS=true, which trades the gate away wholesale. That is the wrong shape: it is all-or-nothing, per-deployment, and invisible to the user.

### 8.2 The fix — resume-after-approval, using what already exists

AgentApproval (model + /api/agent-approvals, /approve, /deny) is already implemented, including an inputHash and a 422 on hash mismatch. Wire it to remote MCP:

1. Mutating tool called over remote → **do not execute**. Create an AgentApproval row with status: PENDING, actionName, the full input, and inputHash.
2. Return a **non-error, structured MCP result**: pending status, approvalId, a human approval URL, and an explicit instruction to poll. It must not read as a failure — the agent should understand this as "awaiting human", not "denied".
3. Human approves in the app (later: Slack/email — out of scope here).
4. Agent re-calls the same tool with approvalId. Server re-computes inputHash and **rejects on mismatch (422)** — this is the load-bearing check. It stops an agent from getting approval for a benign input and then executing a different one. Do not weaken or skip it.
5. On match + APPROVED: execute once, stamp executedAt, store result. Any subsequent call with the same approvalId returns the stored result rather than re-executing.

### 8.3 Non-negotiables

- **Fail-closed stays the default.** No approval channel and no approved AgentApproval → refuse. The new path adds a way to _get_ approval; it must never add a way to _skip_ it.
- **Idempotency via approvalId + inputHash.** A retry must never start a second scan. Enforce at the DB level (executedAt non-null ⇒ return stored result).
- **Expiry.** expiresAt must be set and enforced; an approval that has been sitting for hours is stale consent. Propose 15 minutes for founder confirmation.
- **Rate limit approval creation** per workspace, or a hostile/looping agent can flood a human with prompts. Reuse the sliding-window helper in apps/web/src/lib/rate-limit.ts.
- **Write scope still required.** An approved request from a read-only key is still refused — approval is orthogonal to authorisation, not a substitute for it.
- **Deduplicate.** Identical (workspaceId, actionName, inputHash) while PENDING returns the existing approval instead of creating another.
- **Audit everything.** Who approved, when, from where. This is trust-product surface area.
- Keep LYRASHIELD_MCP_ALLOW_REMOTE_MUTATIONS working for genuinely trusted CI, but document that the approval flow is the recommended path and the flag is a blunt instrument.

### 8.4 Also in PR 3

- Add agent-approvals (list/approve/deny) to /api/v1 now that its semantics are settled (deliberately deferred from PR 1 — §5.3).
- SDK + CLI support: lyrashield approvals list|approve|deny, and the CLI should render a pending-approval result from a tool call legibly.
- Update remote-mcp.astro and the FAQ, which currently state that remote mutations are refused — after this PR that is only true _pending approval_. Docs must not overstate the new capability either: read-only still works everywhere, mutations still require a human.
- **Verify end-to-end on at least one real cloud platform** before claiming the four are unlocked. Report which were actually tested; do not assert Lovable, Bolt, Replit and v0 all work on the strength of one.

## 9. Deferred — Phase 4: Agent Identity & Trust Record (fast-follow)

**Founder decision 2026-07-31: not in PR 1–3.** Ship the integration surface first, gather real install telemetry, then design identity against evidence rather than assumption. **Do not add a Prisma migration to PR 1–3.**

Recorded here so the design intent is not lost, and so PR 1–3 avoid decisions that would make it harder.

### 9.1 Why it matters

This is the "trust" half of "agentic security/trust SaaS". Today a scan is attributed to a **workspace** API key (ApiKey.scopes: ["read"|"write"]). LyraShield therefore cannot answer:

- _Which_ agent requested this scan — Cursor, Claude Code, or a Lovable build bot?
- Can we revoke or rate-limit **one** agent without breaking every other integration in the workspace?
- What has this agent shipped, what was scanned, what was verified fixed, what is still outstanding?

Every competitor can scan code. Almost none can answer those three questions. That asymmetry is the differentiator, and it is why identity is worth doing properly rather than quickly.

### 9.2 Sketch

- **AgentInstall / AgentIdentity** — a credential bound to (workspaceId, agentKind, installId), where agentKind is a registry AgentEntry.id. Gives per-agent revocation, per-agent rate limits, per-agent audit trail.
- **Attribution** — record the requesting agent identity on Scan, Finding, FixProposal, Retest.
- **Trust record** — per-agent, per-repo: work shipped, scanned, verified-fixed, outstanding. Built on the existing packages/score / ScoreSnapshot layer rather than a parallel system.
- **Public exposure, if any, goes through buildScorecardPayload in packages/db/src/score-service.ts — the only permitted public-payload constructor. Its allowlist regression test is load-bearing and must not be relaxed.**

### 9.3 What PR 1–3 must do now to keep this cheap later

1. **lyrashield init should generate a stable, non-identifying local installId** (random UUID in ~/.lyrashield/) and record which agent it configured. No server call, no telemetry transmission — just make the local fact exist so identity can adopt it later without asking users to re-onboard.
2. **The SDK should send a User-Agent naming the client and version** (e.g. lyrashield-cli/0.1.0, lyrashield-mcp/0.2.0). Cheap now, and it is the crudest possible form of agent attribution — enough to answer "are people actually installing this?" before building the full model.
3. **Do not model anything that assumes keys are workspace-only** in the SDK's public types. Keep the auth surface a single opaque credential so agent-scoped credentials slot in without a breaking change.
4. **Ask the founder before adding any outbound telemetry.** Counting installs is legitimate; doing it without consent in a security product is not. This is a founder gate, not an engineering judgement call.

## 10. Founder Gates — Stop and Ask

Do not self-authorise any of these. Stop, present the evidence, and wait for Ankit.

| #   | Gate                                                              | Why it needs the founder                                                                                                                          |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Publishing lyrashield and @lyrashield/cli to npm**              | Public and effectively irreversible. Names verified available 2026-07-31; **squatting risk is real, so raise this early rather than at the end.** |
| 2   | **Publishing any new @lyrashield/mcp version**                    | Users run npx -y @lyrashield/mcp — a bad publish breaks all 15 integrations immediately, with no rollback for cached installs.                    |
| 3   | **Rendering npx lyrashield install … in public docs**             | Do not publish instructions for a command that is not yet on npm. Gate behind gate 1.                                                             |
| 4   | **Exposing /api/v1 publicly + the OpenAPI spec**                  | This is a public API contract. Once third parties depend on it, changes are breaking.                                                             |
| 5   | **Merging PR 3 (remote approval)**                                | Security-critical: modifies an approval gate. Needs an explicit review of the fail-closed default and the inputHash check.                        |
| 6   | **Extending PROTECTIVE_INSTRUCTION_PATTERNS** (§7.4)              | Security-critical: a careless pattern is an allowlist bypass in our own scanner.                                                                  |
| 7   | **Any Prisma migration**                                          | Out of scope for PR 1–3 entirely. If you believe one is needed, stop and ask rather than adding it.                                               |
| 8   | **Any outbound telemetry from the CLI** (§9.3)                    | Consent matters, especially in a security product.                                                                                                |
| 9   | **Marketing copy, or the public /integrations hub**               | Owned by the LyraShield Marketing Agent. Produce registry-driven data and a dev-ready brief; do not write the copy.                               |
| 10  | _*Deprecating or changing any existing unversioned /api/* route_* | Additive-only is a hard constraint (§2.4).                                                                                                        |

**Also flag, without blocking:** if you find that a vendor has changed a config path or root key (likely for at least one of the 15), report it as a finding with the source URL. That is exactly the drift the conformance suite exists to catch, and it is worth the founder knowing which vendors move.

## 11. Must-Verify — Do Not Guess

Everything in §3.3 was read out of our own docs pages at cef548d. That makes it authoritative for **what we currently publish** — not necessarily for **what is currently true of each vendor**. Vendors move config paths and rename keys, and a wrong path in an installer fails _silently_, which is the worst failure mode available to us.

**Rule: verify against the vendor's live documentation before writing a writer for it. If you cannot verify, set that agent to guided-manual and say so in the PR. Never guess a path.**

### 11.1 Blocking — a writer cannot ship without these

| #   | Unknown                                     | Why it blocks                                                                                                                                                                                        |
| --- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **PiCode** config file path                 | Our docs give the shape (mcpServers) but no path. Cannot write a file without one.                                                                                                                   |
| 2   | **Hermes** profile YAML path                | Same — shape known, path not documented.                                                                                                                                                             |
| 3   | **OpenClaw** mcporter.yaml resolution order | "mcporter.yaml or the agent profile YAML" is ambiguous. Which wins? Where does it live?                                                                                                              |
| 4   | **Cline** cline_mcp_settings.json real path | Docs say "managed via the panel". The file exists on disk (VS Code global storage) — find and confirm the actual path per OS, or keep Cline guided-manual.                                           |
| 5   | **VS Code global** MCP settings key         | Our page hedges: "github.copilot.chat.agent.mcpServers **or equivalent** user-level MCP key". Hedged wording is not implementable. Project-level .vscode/mcp.json + servers is solid; global is not. |
| 6   | **JetBrains** settings file path per IDE/OS | Confirm whether a writable file exists at all. If it does, JetBrains can be promoted from guided-manual.                                                                                             |

### 11.2 Non-blocking — verify and correct

7. **Cursor cursor://mcp/install deeplink** — our docs mention it but defer the format. Worth having: a deeplink is a genuinely one-click install. Confirm the format.
8. **Which agents actually read AGENTS.md** — we assert Codex, Junie and Hermes. The list is probably longer now (OpenCode, Amp, Zed are plausible). Verify before claiming it in PR 2 (§7.2).
9. **Claude Code plugin/skills/hooks API surface** — confirm the current shape before building the plugin (§7.2); this API has moved.
10. **claude mcp add flag syntax** — our page shows --command / --args / --env; the MCP README shows the -e KEY=v -- npx … form. These disagree. Determine which is current before shelling out to it.
11. **Windsurf serverUrl vs url** — confirm; the JSON agents mostly use url, and Windsurf being different is exactly the kind of detail that changes.
12. **Gemini CLI env-stripping behaviour** — confirm the KEY/TOKEN/SECRET filter still applies. Our whole inline-secret exception for Gemini (§5.2 rule 5) rests on it.
13. **Zed context_servers** — confirm Zed has not migrated to a standard mcpServers-style key.
14. **Codex env_vars vs env** — confirm this is still current TOML shape.

### 11.3 Internal, verify in-repo

15. **Whether checkApiRateLimit is actually wired** to /api/* via Next.js middleware. /api/mcp's docstring claims a "shared /api/* middleware bucket", but no middleware calling it was found in the API tree. If it is not wired, v1 routes inherit no IP rate limit — report this as a finding rather than silently assuming coverage.
16. **packages/mcp's actual zod usage** — its tools declare plain JSON-Schema inputSchema objects, so the zod 3 pin may be vestigial (an MCP SDK peer). Confirm before designing the SDK boundary (§4.6).
17. **Whether .env is gitignored** in a fresh consumer project before the CLI writes to it (§2.1).
18. **workspaceId handling on GET /api/targets** — it uses getSession() plus a direct membership check rather than requirePermission, unlike its siblings. Confirm this is intentional before exposing it under v1; if it is an oversight, report it rather than fixing it inside this PR.

## 12. Verification & Definition of Done

"Done" means verified by execution, not by inspection. A PR that has not run these is not ready for review.

### 12.1 Commands that must pass (repo root)

```bash
pnpm install
pnpm typecheck        # turbo, all packages
pnpm lint             # eslint 9 + eslint-plugin-security
pnpm build            # turbo build, all packages + apps
pnpm test             # root vitest + marketing vitest + marketing-motion node:test
pnpm format:check     # prettier over tracked ts/tsx/md/json/yml
```

Note pnpm test at root is a compound script — it runs the root vitest suite, then @lyrashield/marketing's own vitest run, then node --test apps/marketing-motion/tests/*.test.mjs. All three must be green.

build, lint and typecheck all dependsOn: ["^build"], so a new package with a broken build script will fail its dependents in confusing ways — get tsup working early.

### 12.2 PR 1 acceptance criteria

- [ ] All 15 registry entries validate against src/schema.ts; renderer snapshots reviewed against §3.3 and §3.4 by eye, not just accepted.
- [ ] Every gotcha in §3.4 has a named, failing-if-broken test.
- [ ] Merge-safety: a foreign MCP server and unrelated settings survive install byte-identically; JSONC comments survive.
- [ ] Idempotency: second init is a no-op reporting ALREADY_CONFIGURED.
- [ ] Uninstall returns the file to its original bytes.
- [ ] **No lsk\_ literal is ever rendered into a sharedByConvention location without --inline-secret; a git-tracked, non-gitignored shared file refuses even with the flag.**
- [ ] --dry-run writes nothing and prints an accurate diff.
- [ ] All 18 v1 routes resolve; parity test proves method-for-method identity with unversioned twins.
- [ ] Every unversioned route still behaves identically (nothing removed, nothing changed).
- [ ] OpenAPI spec validates against the 3.1 meta-schema; coverage test asserts all 18 routes present.
- [ ] **packages/mcp's existing test suite passes unchanged** after the SDK rewire.
- [ ] CLI: login, use, agents, doctor, init --dry-run, scan, status, findings, gate all exercised against a running local app.
- [ ] doctor correctly detects a config written under the _wrong_ root key (test it deliberately — write mcpServers into a VS Code file and confirm it is flagged).
- [ ] No key appears in any output, including --dry-run, doctor, and error paths.
- [ ] Exit codes documented and asserted.
- [ ] Docs build green; docs/registry consistency test proves published snippets match renderConfig() output.
- [ ] init reports per-agent outcomes using the §4.4 vocabulary and never overstates.
- [ ] docs/agent-integrations.md explains adding agent #16 in one entry + one fixture — and that claim is true.
- [ ] Nothing published to npm; no migration; no marketing copy.

### 12.3 Manual verification worth doing

Automated tests prove we write what we intended. They do not prove an agent loads it. Before claiming an integration works, **install into at least three real agents locally** — pick one JSON (cursor), one exotic-root-key (vscode or zed), and one non-JSON (openai-codex) — and confirm the agent actually lists the LyraShield tools.

Report exactly which agents were manually verified and which were only conformance-tested. Do not describe untested agents as working. This is the same distinction the product itself draws between NO_FINDING and independently verified (§4.4) — hold the handoff to the standard the product sells.

### 12.4 PR description must include

1. What changed, why, and the commit it was based on.
2. Verification evidence — the actual command output for §12.1.
3. Which agents were manually verified vs conformance-tested only (§12.3).
4. Every §11 item resolved, with the vendor source URL and date checked; anything unresolved, and which agents were consequently left guided-manual.
5. Any security-relevant decision, called out explicitly for founder review.
6. Deviations from this handoff, with reasoning. **Deviating is fine when the code disagrees with this document — the live code is the source of truth. Say so rather than forcing a wrong plan through.**
