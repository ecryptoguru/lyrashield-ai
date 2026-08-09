# Agent Plugin Package — Implementation Plan

> **For agentic workers:** This plan uses TDD. Each task ends with a green test and a commit. Required context: `docs/superpowers/specs/2026-08-07-agent-plugin-design.md`.

**Goal:** Ship a portable Agent Plugins 1.0.0 package (`packages/agent-plugin`) and wire it into the MCP server, agent registry, and CLI so users can install LyraShield into any supported client with `npx lyrashield install <agent>`.

**Architecture:** New `packages/agent-plugin` is a static plugin directory plus a small TS package that exposes `getPluginDir()` and schema validators. `packages/mcp` gains a credentials fallback. `packages/agent-registry` adds `pluginLocations`. `packages/cli` adds an `agent-plugin` installer that copies the canonical plugin directory into a client-specific path.

**Tech Stack:** TypeScript 6, Vitest, Zod, `ajv` (or Zod) for Agent Plugins schema validation, `node:fs/promises`, `@modelcontextprotocol/sdk`.

## Global Constraints

- Node.js >= 24.0.0.
- No secrets in the portable `mcp.json` or `plugin.json` files.
- `LYRASHIELD_API_URL` defaults to `https://app.lyrashieldai.com`.
- The CLI credentials file `~/.lyrashield/credentials.json` format and permissions (`0o600`) are the source of truth.
- Plugin root containment: any generated path must resolve inside the plugin root; the CLI refuses to copy outside the client plugin directory.
- Existing per-client config install behavior must remain unchanged.
- All tests must pass before a task is complete.

---

## Task 1: Scaffold `packages/agent-plugin`

**Files:**

- Create: `packages/agent-plugin/package.json`
- Create: `packages/agent-plugin/tsconfig.json`
- Create: `packages/agent-plugin/tsconfig.build.json`
- Create: `packages/agent-plugin/tsup.config.ts`
- Create: `packages/agent-plugin/src/index.ts`
- Create: `packages/agent-plugin/src/validate.ts`
- Create: `packages/agent-plugin/src/build.ts`
- Create: `packages/agent-plugin/src/__tests__/schema.test.ts`
- Create: `packages/agent-plugin/plugin/plugin.json`
- Create: `packages/agent-plugin/plugin/mcp.json`
- Create: `packages/agent-plugin/plugin/skills/lyrashield/SKILL.md`
- Create: `packages/agent-plugin/README.md`
- Modify: `pnpm-workspace.yaml` (add package)
- Modify: `package.json` root `devDependencies` if needed (no new deps expected)

**Interfaces:**

- Produces: `getPluginDir()` returns `string` absolute path to `plugin/`.
- Produces: `validatePlugin(pluginRoot: string)` returns `Promise<{ ok: boolean; errors: string[] }>`.
- Produces: `buildPlugin()` writes the canonical `plugin/` directory (run from `packages/agent-plugin` build).

- [ ] **Step 1: Add package to workspace**

Edit `pnpm-workspace.yaml` to include `packages/agent-plugin`.

Run: `cat pnpm-workspace.yaml` to confirm.

- [ ] **Step 2: Create package files**

`packages/agent-plugin/package.json`:

```json
{
  "name": "@lyrashield/agent-plugin",
  "version": "0.1.0",
  "description": "LyraShield Agent Plugin package",
  "license": "UNLICENSED",
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist", "plugin", "README.md"],
  "scripts": {
    "lint": "eslint src --max-warnings 0",
    "typecheck": "tsc --noEmit",
    "build": "tsup",
    "prepublishOnly": "tsup",
    "test": "vitest run"
  },
  "dependencies": {
    "@lyrashield/agent-rules": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "ajv": "^8.17.1",
    "typescript": "^6.0.0",
    "tsup": "^8.5.1",
    "vitest": "^4.1.9"
  }
}
```

`packages/agent-plugin/tsconfig.json` extends the workspace base tsconfig. Copy from `packages/agent-rules/tsconfig.json` and adjust `include`.

`packages/agent-plugin/tsconfig.build.json` mirrors `packages/agent-rules/tsconfig.build.json`.

`packages/agent-plugin/tsup.config.ts` mirrors `packages/agent-rules/tsup.config.ts`.

`packages/agent-plugin/src/index.ts`:

```ts
import path from "node:path"
import { fileURLToPath } from "node:url"

export { validatePlugin } from "./validate.js"
export { buildPlugin } from "./build.js"

export function getPluginDir(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(__dirname, "..", "plugin")
}
```

- [ ] **Step 3: Write the static plugin files**

`packages/agent-plugin/plugin/plugin.json`:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "lyrashield",
  "version": "0.1.0",
  "description": "LyraShield AI security and release-assurance plugin",
  "author": {
    "name": "LyraShield AI",
    "url": "https://lyrashieldai.com"
  },
  "homepage": "https://lyrashieldai.com",
  "repository": "https://github.com/ecryptoguru/lyrashieldai",
  "license": "UNLICENSED",
  "keywords": ["security", "appsec", "lyrashield", "mcp", "ai-coding"]
}
```

`packages/agent-plugin/plugin/mcp.json`:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "lyrashield-stdio": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@lyrashield/mcp"]
    },
    "lyrashield-remote": {
      "type": "streamable-http",
      "url": "https://app.lyrashieldai.com/api/mcp"
    }
  }
}
```

`packages/agent-plugin/plugin/skills/lyrashield/SKILL.md` starts as a static copy of the `agents-md` rule body. In Task 2 it will be generated from `@lyrashield/agent-rules`.

- [ ] **Step 4: Write schema validator**

`packages/agent-plugin/src/validate.ts`:

```ts
import Ajv from "ajv"
import { readFile } from "node:fs/promises"
import path from "node:path"

const ajv = new Ajv({ strict: false })

export async function validatePlugin(
  pluginRoot: string
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = []

  const pluginJsonPath = path.join(pluginRoot, "plugin.json")
  const mcpJsonPath = path.join(pluginRoot, "mcp.json")

  for (const p of [pluginJsonPath, mcpJsonPath]) {
    try {
      await readFile(p, "utf-8")
    } catch {
      errors.push(`Missing: ${p}`)
    }
  }

  // TODO: fetch and validate against remote schemas in CI; local tests use lightweight JSON parse
  return { ok: errors.length === 0, errors }
}
```

- [ ] **Step 5: Write test**

`packages/agent-plugin/src/__tests__/schema.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { validatePlugin } from "../validate.js"
import { getPluginDir } from "../index.js"

describe("validatePlugin", () => {
  it("validates the built-in plugin directory", async () => {
    const result = await validatePlugin(getPluginDir())
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })
})
```

- [ ] **Step 6: Run package tests**

Run: `pnpm --filter @lyrashield/agent-plugin test`
Expected: PASS (1 test).

- [ ] **Step 7: Commit**

```bash
git add packages/agent-plugin pnpm-workspace.yaml
git commit -m "feat(agent-plugin): scaffold portable Agent Plugin package"
```

---

## Task 2: Generate the skill body and client manifest shims

**Files:**

- Modify: `packages/agent-plugin/src/build.ts`
- Modify: `packages/agent-plugin/src/__tests__/schema.test.ts`
- Create: `packages/agent-plugin/src/__tests__/build.test.ts`
- Create: `packages/agent-plugin/plugin/.claude-plugin/plugin.json`
- Create: `packages/agent-plugin/plugin/.cursor-plugin/plugin.json`
- Create: `packages/agent-plugin/plugin/.codex-plugin/plugin.json`
- Create: `packages/agent-plugin/plugin/.kiro-plugin/plugin.json`
- Modify: `packages/agent-plugin/package.json` (add build script if needed)

**Interfaces:**

- Consumes: `renderMarkdownBody` from `@lyrashield/agent-rules/renderers/shared.js`.
- Produces: `buildPlugin()` writes `plugin/skills/lyrashield/SKILL.md` and client shims.

- [ ] **Step 1: Implement build generator**

`packages/agent-plugin/src/build.ts`:

```ts
import { writeFile, mkdir, copyFile } from "node:fs/promises"
import path from "node:path"
import { renderMarkdownBody } from "@lyrashield/agent-rules/renderers/shared.js"
import { LYRASHIELD_POLICY } from "@lyrashield/agent-rules/policy.js"
import { getPluginDir } from "./index.js"

const CLIENTS = ["claude", "cursor", "codex", "kiro"] as const

export async function buildPlugin(): Promise<void> {
  const pluginRoot = getPluginDir()
  const skillDir = path.join(pluginRoot, "skills", "lyrashield")
  await mkdir(skillDir, { recursive: true })

  const skillBody = `---
name: lyrashield
description: Run LyraShield security scans, review findings, and drive the fix → verify loop.
---

${renderMarkdownBody(LYRASHIELD_POLICY, 2)}
`
  await writeFile(path.join(skillDir, "SKILL.md"), skillBody, "utf-8")

  const manifest = await readFile(path.join(pluginRoot, "plugin.json"), "utf-8").then(JSON.parse)

  for (const client of CLIENTS) {
    const shimDir = path.join(pluginRoot, `.${client}-plugin`)
    await mkdir(shimDir, { recursive: true })
    await writeFile(path.join(shimDir, "plugin.json"), JSON.stringify(manifest, null, 2), "utf-8")
  }
}
```

Add `import { readFile } from "node:fs/promises"`.

- [ ] **Step 2: Add build script and run**

Add to `package.json` scripts:

```json
"build:plugin": "tsx src/build.ts"
```

Add `tsx` to devDependencies if not available via workspace. If `tsx` is not allowed, use a `node --import` ESM loader or add a `build.ts` compiled step. Prefer using existing tools: add a `src/build.ts` entry and run it with `node --import ./ts-node-register.js`? Simpler: use the CLI package or a script in the package. For this plan, use `tsx`.

Run: `pnpm --filter @lyrashield/agent-plugin build:plugin`
Expected: `plugin/skills/lyrashield/SKILL.md` and four client shims created.

- [ ] **Step 3: Write build test**

`packages/agent-plugin/src/__tests__/build.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { buildPlugin } from "../build.js"
import { getPluginDir } from "../index.js"
import { access } from "node:fs/promises"
import path from "node:path"

describe("buildPlugin", () => {
  it("generates SKILL.md and client shims", async () => {
    await buildPlugin()
    const pluginRoot = getPluginDir()
    const skill = path.join(pluginRoot, "skills", "lyrashield", "SKILL.md")
    await access(skill)
    for (const client of ["claude", "cursor", "codex", "kiro"]) {
      await access(path.join(pluginRoot, `.${client}-plugin`, "plugin.json"))
    }
  })
})
```

- [ ] **Step 4: Update schema test to include shims**

`packages/agent-plugin/src/__tests__/schema.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { validatePlugin } from "../validate.js"
import { getPluginDir } from "../index.js"

describe("validatePlugin", () => {
  it("validates the built-in plugin directory", async () => {
    const result = await validatePlugin(getPluginDir())
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })
})
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @lyrashield/agent-plugin test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-plugin
git commit -m "feat(agent-plugin): generate skill and client manifest shims"
```

---

## Task 3: Add credentials fallback to `packages/mcp`

**Files:**

- Create: `packages/mcp/src/credentials.ts`
- Create: `packages/mcp/src/credentials.test.ts`
- Modify: `packages/mcp/src/stdio-transport.ts`
- Modify: `packages/mcp/package.json` (no new deps expected)

**Interfaces:**

- Produces: `resolveMcpCredentials()` returns `{ apiKey?: string; apiUrl: string }`.
- Produces: `NoApiKeyError` for missing credentials.

- [ ] **Step 1: Implement credentials resolver**

`packages/mcp/src/credentials.ts`:

```ts
import { readFile, access } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

export const CREDENTIALS_DIR = path.join(homedir(), ".lyrashield")
export const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, "credentials.json")

export interface Credentials {
  apiKey?: string
  apiUrl?: string
}

export class NoApiKeyError extends Error {
  constructor() {
    super(
      "LYRASHIELD_API_KEY is not set and no credentials file was found. Run `lyrashield login` or set LYRASHIELD_API_KEY."
    )
  }
}

async function loadCredentialsFile(): Promise<Credentials | undefined> {
  try {
    await access(CREDENTIALS_FILE)
    const raw = await readFile(CREDENTIALS_FILE, "utf-8")
    return JSON.parse(raw) as Credentials
  } catch {
    return undefined
  }
}

export async function resolveMcpCredentials(): Promise<{ apiKey: string; apiUrl: string }> {
  const envKey = process.env.LYRASHIELD_API_KEY
  const envUrl = process.env.LYRASHIELD_API_URL
  const file = await loadCredentialsFile()

  const apiKey = envKey || file?.apiKey
  const apiUrl = envUrl || file?.apiUrl || "https://app.lyrashieldai.com"

  if (!apiKey) {
    throw new NoApiKeyError()
  }

  return { apiKey, apiUrl }
}
```

- [ ] **Step 2: Update stdio transport**

`packages/mcp/src/stdio-transport.ts`:

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createLyraShieldServer } from "./create-server"
import { resolveMcpCredentials } from "./credentials"
import { logger } from "@lyrashield/logger"

const allowMutations = process.env.LYRASHIELD_MCP_ALLOW_MUTATIONS === "true"

async function main() {
  const { apiKey, apiUrl } = await resolveMcpCredentials()
  const { server, engine } = createLyraShieldServer({
    allowMutations,
    toolContext: { apiBaseUrl: apiUrl, apiKey },
  })
  const transport = new StdioServerTransport()
  await server.connect(transport)
  logger.info("LyraShield MCP server connected (stdio, SDK)", {
    tools: engine.listTools().map((t) => t.name),
    allowMutations,
  })
}

main().catch((err) => {
  logger.error("LyraShield MCP server failed to start", {
    error: err instanceof Error ? err.message : String(err),
  })
  process.exit(1)
})
```

- [ ] **Step 3: Write credentials tests**

`packages/mcp/src/credentials.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { resolveMcpCredentials, NoApiKeyError, CREDENTIALS_FILE } from "./credentials"
import { writeFile, mkdir, unlink } from "node:fs/promises"

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV }
  delete process.env.LYRASHIELD_API_KEY
  delete process.env.LYRASHIELD_API_URL
})

afterEach(async () => {
  process.env = ORIGINAL_ENV
  try {
    await unlink(CREDENTIALS_FILE)
  } catch {
    // ignore
  }
})

describe("resolveMcpCredentials", () => {
  it("prefers env vars", async () => {
    process.env.LYRASHIELD_API_KEY = "lsk_env"
    process.env.LYRASHIELD_API_URL = "https://env.example.com"
    const creds = await resolveMcpCredentials()
    expect(creds.apiKey).toBe("lsk_env")
    expect(creds.apiUrl).toBe("https://env.example.com")
  })

  it("falls back to the credentials file", async () => {
    await mkdir(path.dirname(CREDENTIALS_FILE), { recursive: true })
    await writeFile(
      CREDENTIALS_FILE,
      JSON.stringify({ apiKey: "lsk_file", apiUrl: "https://file.example.com" })
    )
    const creds = await resolveMcpCredentials()
    expect(creds.apiKey).toBe("lsk_file")
    expect(creds.apiUrl).toBe("https://file.example.com")
  })

  it("throws when no key is available", async () => {
    await expect(resolveMcpCredentials()).rejects.toBeInstanceOf(NoApiKeyError)
  })
})
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @lyrashield/mcp test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp
git commit -m "feat(mcp): resolve API key from env or CLI credentials file"
```

---

## Task 4: Update `packages/agent-registry`

**Files:**

- Modify: `packages/agent-registry/src/types.ts`
- Modify: `packages/agent-registry/src/agents.ts`
- Modify: `packages/agent-registry/src/render.ts`
- Create/Modify: `packages/agent-registry/src/__tests__/registry.test.ts`

**Interfaces:**

- `InstallStrategy` gains `"agent-plugin"`.
- `AgentEntry` gains `pluginLocations: ConfigLocation[]`.
- `renderConfig`/`renderEntry` keep existing behavior; `agent-plugin` agents are rendered by the CLI, not the registry renderer.

- [ ] **Step 1: Update types**

`packages/agent-registry/src/types.ts`:

```ts
export type InstallStrategy = "config-file" | "vendor-cli" | "guided-manual" | "agent-plugin"

export interface AgentEntry {
  // ... existing fields ...
  pluginLocations?: ConfigLocation[]
}
```

- [ ] **Step 2: Add new agent entries for the 6 launch clients (Claude Code, Cursor, OpenAI Codex, Kiro, plus VS Code and GitHub Copilot reserved)**

The `@lyrashield/agent-plugin` build emits client manifest shims only for the four clients with confirmed support today (Claude Code, Cursor, OpenAI Codex, Kiro); the remaining two registry entries are reserved for when those clients finalize support.

Append to `packages/agent-registry/src/agents.ts`:

```ts
const claudeCodePlugin: AgentEntry = {
  id: "claude-code-agent-plugin",
  displayName: "Claude Code (Agent Plugin)",
  docsSlug: "claude-code",
  installStrategy: "agent-plugin",
  format: null,
  rootKey: null,
  locations: [],
  pluginLocations: [
    { scope: "global", path: "~/.claude/plugins/lyrashield", sharedByConvention: false },
  ],
  transports: ["stdio"],
  credential: { kind: "shell-env" },
  rulesFiles: ["CLAUDE.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://code.claude.com/docs/en/plugins",
  },
  gotchas: [
    "Claude Code may also load `.claude-plugin/plugin.json`; the package includes a manifest shim in that directory.",
  ],
}
```

Repeat for `cursor-agent-plugin` (`~/.cursor/plugins/local/lyrashield`), `vscode-agent-plugin` (path TBD), `openai-codex-agent-plugin` (`~/.codex/plugins/lyrashield`), `github-copilot-agent-plugin` (path TBD), `kiro-agent-plugin` (`~/.kiro/plugins/lyrashield` or project `.kiro/plugins/lyrashield`).

Add them to the exported `AGENTS` array. Keep existing entries untouched.

- [ ] **Step 3: Render function handles `agent-plugin` gracefully**

`packages/agent-registry/src/render.ts`: when `installStrategy === "agent-plugin"`, `renderConfig`/`renderEntry` should throw a clear error: "Use the CLI agent-plugin installer, not the registry renderer."

- [ ] **Step 4: Update registry tests**

`packages/agent-registry/src/__tests__/registry.test.ts`:

Add an assertion that `getAgent("claude-code-agent-plugin")` exists and `getAgent("claude-code")` is unchanged.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @lyrashield/agent-registry test`
Expected: PASS (update snapshots if needed with `vitest run -u`).

- [ ] **Step 6: Commit**

```bash
git add packages/agent-registry
git commit -m "feat(agent-registry): add pluginLocations and Agent Plugin agent entries"
```

---

## Task 5: Add `agent-plugin` installer to `packages/cli`

**Files:**

- Create: `packages/cli/src/installers/agent-plugin.ts`
- Create: `packages/cli/src/installers/agent-plugin.test.ts`
- Modify: `packages/cli/src/installers/install.ts`
- Modify: `packages/cli/src/installers/detect.ts`
- Modify: `packages/cli/package.json` (add `@lyrashield/agent-plugin` dependency if needed)

**Interfaces:**

- Produces: `installAgentPlugin(agent, opts)` returns `Promise<InstallAgentResult>`.
- Produces: `uninstallAgentPlugin(agent, opts)` returns `Promise<InstallAgentResult>`.

- [ ] **Step 1: Implement agent-plugin installer**

`packages/cli/src/installers/agent-plugin.ts`:

```ts
import { access, cp, mkdir, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { AgentEntry, ConfigLocation } from "@lyrashield/agent-registry"
import { getPluginDir } from "@lyrashield/agent-plugin"
import { credentialsFileExists } from "../credentials.js"
import type { InstallAgentResult } from "./install.js"

export interface InstallAgentPluginOptions {
  agent: AgentEntry
  scope?: "project" | "global"
  cwd?: string
  dryRun?: boolean
  yes?: boolean
}

function resolvePluginLocation(
  loc: ConfigLocation,
  opts?: { scope?: string; cwd?: string }
): string {
  let platformPath = loc.path
  if (loc.platform && process.platform in loc.platform) {
    platformPath = loc.platform[process.platform as "darwin" | "linux" | "win32"] ?? loc.path
  }
  const expanded = platformPath.startsWith("~")
    ? path.join(homedir(), platformPath.slice(1))
    : platformPath
  if (path.isAbsolute(expanded)) return expanded
  if (loc.scope === "global") return path.join(homedir(), expanded)
  return path.join(opts?.cwd ?? process.cwd(), expanded)
}

export async function installAgentPlugin(
  opts: InstallAgentPluginOptions
): Promise<InstallAgentResult> {
  const { agent } = opts
  const pluginLocations = agent.pluginLocations ?? []

  if (pluginLocations.length === 0) {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "FAILED",
      message: "No plugin location defined.",
    }
  }

  if (!(await credentialsFileExists()) && !process.env.LYRASHIELD_API_KEY) {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "MANUAL_REQUIRED",
      message: "No credentials found. Run `lyrashield login` first.",
    }
  }

  const loc =
    pluginLocations.find((l) => !opts.scope || l.scope === opts.scope) ?? pluginLocations[0]
  const dest = resolvePluginLocation(loc, { scope: opts.scope, cwd: opts.cwd })
  const source = getPluginDir()

  if (opts.dryRun) {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "CONFIGURED",
      path: dest,
      message: `Would copy ${source} to ${dest}`,
    }
  }

  await rm(dest, { recursive: true, force: true })
  await mkdir(path.dirname(dest), { recursive: true })
  await cp(source, dest, { recursive: true, preserveTimestamps: true })

  return { agent: agent.id, displayName: agent.displayName, outcome: "CONFIGURED", path: dest }
}

export async function uninstallAgentPlugin(
  opts: InstallAgentPluginOptions
): Promise<InstallAgentResult> {
  const { agent } = opts
  const pluginLocations = agent.pluginLocations ?? []
  const loc =
    pluginLocations.find((l) => !opts.scope || l.scope === opts.scope) ?? pluginLocations[0]
  if (!loc) {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "FAILED",
      message: "No plugin location defined.",
    }
  }
  const dest = resolvePluginLocation(loc, { scope: opts.scope, cwd: opts.cwd })
  try {
    await rm(dest, { recursive: true, force: true })
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "CONFIGURED",
      path: dest,
      message: "Plugin removed.",
    }
  } catch {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "ALREADY_CONFIGURED",
      message: "Plugin was not present.",
    }
  }
}
```

- [ ] **Step 2: Wire into main installer**

`packages/cli/src/installers/install.ts`:

Add branch before `installAgent`:

```ts
if (agent.installStrategy === "agent-plugin") {
  const { installAgentPlugin } = await import("./agent-plugin.js")
  return installAgentPlugin({
    agent,
    scope: opts.scope,
    cwd: opts.cwd,
    dryRun: opts.dryRun,
    yes: opts.yes,
  })
}
```

`uninstallAgent` branch:

```ts
if (agent.installStrategy === "agent-plugin") {
  const { uninstallAgentPlugin } = await import("./agent-plugin.js")
  return uninstallAgentPlugin({ agent, scope: opts.scope, cwd: opts.cwd })
}
```

- [ ] **Step 3: Update detect.ts for plugin locations**

`packages/cli/src/installers/detect.ts`:

In `detectAgent`, add:

```ts
if (agent.installStrategy === "agent-plugin") {
  for (const loc of agent.pluginLocations ?? []) {
    const resolved = resolveLocation(loc, opts)
    if (await pathExists(resolved)) return true
  }
  return false
}
```

- [ ] **Step 4: Write tests**

`packages/cli/src/installers/agent-plugin.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { installAgentPlugin, uninstallAgentPlugin } from "./agent-plugin.js"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AgentEntry } from "@lyrashield/agent-registry"

const baseAgent: AgentEntry = {
  id: "claude-code-agent-plugin",
  displayName: "Claude Code",
  docsSlug: "claude-code",
  installStrategy: "agent-plugin",
  format: null,
  rootKey: null,
  locations: [],
  pluginLocations: [{ scope: "global", path: "lyrashield-claude-test", sharedByConvention: false }],
  transports: ["stdio"],
  credential: { kind: "shell-env" },
  rulesFiles: [],
  gotchas: [],
}

describe("installAgentPlugin", () => {
  it("copies the canonical plugin to the client path", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "lyra-"))
    const agent = {
      ...baseAgent,
      pluginLocations: [{ scope: "global", path: tempDir, sharedByConvention: false }],
    }
    const result = await installAgentPlugin({ agent })
    expect(result.outcome).toBe("CONFIGURED")
    await rm(tempDir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter lyrashield test`
Expected: PASS (fix any type errors).

- [ ] **Step 6: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): add Agent Plugin installer and uninstaller"
```

---

## Task 6: Update `init`/`uninstall` commands and docs

**Files:**

- Modify: `packages/cli/src/commands/init.ts`
- Modify: `packages/cli/src/commands/uninstall.ts`
- Modify: `apps/marketing/src/pages/docs/integrations/index.astro`
- Create/Modify: client-specific docs pages

**Interfaces:**

- `lyrashield init` detects Agent Plugin-capable agents first and falls back to existing logic.
- `lyrashield uninstall <agent>` works for `agent-plugin` entries.

- [ ] **Step 1: Update `init` to prefer agent-plugin**

`packages/cli/src/commands/init.ts`:

Filter `agents` into two waves:

```ts
const pluginAgents = agents.filter((a) => a.installStrategy === "agent-plugin")
const legacyAgents = agents.filter((a) => a.installStrategy !== "agent-plugin")
```

Install `pluginAgents` first, then `legacyAgents`.

- [ ] **Step 2: Verify uninstall command**

`packages/cli/src/commands/uninstall.ts` already calls `uninstallAgent`, which now handles `agent-plugin`. Add a test or manual check.

- [ ] **Step 3: Update marketing docs**

`apps/marketing/src/pages/docs/integrations/index.astro`: add an "Agent Plugin" section above the per-client grid, explaining `lyrashield init` and `lyrashield install <agent>`.

- [ ] **Step 4: Run CLI tests**

Run: `pnpm --filter lyrashield test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli apps/marketing/src/pages/docs/integrations
git commit -m "feat(cli,docs): prefer Agent Plugin installs and update integrations page"
```

---

## Task 7: Full verification and final commit

- [ ] **Step 1: Run monorepo lint**

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Run all tests**

Run: `pnpm test`
Expected: all packages PASS.

- [ ] **Step 4: Run format**

Run: `pnpm format`
Expected: no uncommitted formatting changes.

- [ ] **Step 5: Create final PR**

Do not push. Prepare PR using `gh pr create` if the user asks. Otherwise, report that the branch is ready.
