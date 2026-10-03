import type { RegistryAgentEntry } from "./types"
import { LAST_AGENT_REGISTRY_CHECK_DATE } from "./agents/shared"
import { claudeCode, claudeDesktop, claudeWeb, claudeCodePlugin } from "./agents/claude"
import { cursor, cursorPlugin } from "./agents/cursor"
import { devin, devinDesktop, devinCli } from "./agents/devin"
import { openaiCodex, openaiCodexPlugin } from "./agents/openai-codex"
import {
  vscode,
  copilotCli,
  githubCopilotCloudAgent,
  vscodePlugin,
  githubCopilotPlugin,
} from "./agents/github-copilot"
import {
  jetbrains,
  junieIde,
  junieCli,
  jetbrainsClaudeAgent,
  jetbrainsCodexAgent,
} from "./agents/jetbrains"
import { opencode, opencodeV2 } from "./agents/opencode"
import { auggie, augmentVSCode, augmentJetBrains } from "./agents/augment"
import { qoder, qoderCli } from "./agents/qoder"
import {
  cline,
  kiloCode,
  zed,
  geminiCli,
  picode,
  hermes,
  antigravity,
  rooCode,
  mimoCode,
  codebuff,
  ohMyPi,
  qwenCode,
} from "./agents/standalone-config"
import {
  openclaw,
  goose,
  aider,
  factoryDroid,
  continueDev,
  mistralVibe,
  lovable,
  v0,
  replitAgent,
} from "./agents/standalone-guided"
import { amp, kiroPlugin } from "./agents/standalone-other"

const EXPERIMENTAL_AGENT_IDS = new Set([
  "aider",
  "vscode-agent-plugin",
  "github-copilot-agent-plugin",
])
const PACKAGE_CONFORMANCE_AGENT_IDS = new Set([
  "claude-code-agent-plugin",
  "cursor-agent-plugin",
  "openai-codex-agent-plugin",
  "kiro-agent-plugin",
])

export const AGENTS: readonly RegistryAgentEntry[] = [
  claudeCode,
  cursor,
  devin,
  devinDesktop,
  vscode,
  openaiCodex,
  cline,
  opencode,
  opencodeV2,
  kiloCode,
  zed,
  geminiCli,
  jetbrains,
  junieIde,
  junieCli,
  jetbrainsClaudeAgent,
  jetbrainsCodexAgent,
  amp,
  picode,
  openclaw,
  hermes,
  antigravity,
  copilotCli,
  githubCopilotCloudAgent,
  goose,
  aider,
  devinCli,
  rooCode,
  mimoCode,
  codebuff,
  ohMyPi,
  auggie,
  augmentVSCode,
  augmentJetBrains,
  factoryDroid,
  qoder,
  qoderCli,
  qwenCode,
  continueDev,
  mistralVibe,
  lovable,
  v0,
  replitAgent,
  claudeDesktop,
  claudeWeb,
  claudeCodePlugin,
  cursorPlugin,
  vscodePlugin,
  openaiCodexPlugin,
  githubCopilotPlugin,
  kiroPlugin,
].map((agent) => {
  const defaultTier = EXPERIMENTAL_AGENT_IDS.has(agent.id) ? "EXPERIMENTAL" : "COMPATIBLE"
  const evidence =
    agent.verification?.evidence ??
    (PACKAGE_CONFORMANCE_AGENT_IDS.has(agent.id) ? "PACKAGE_CONFORMANCE" : "DOCUMENTATION")

  return {
    ...agent,
    integrationKind: agent.integrationKind ?? "mcp",
    preferredTransport:
      agent.integrationKind === "standalone-cli"
        ? null
        : (agent.preferredTransport ?? agent.transports[0]!),
    remoteAuth:
      agent.installStrategy === "agent-plugin" && agent.transports.includes("remote-http")
        ? (agent.remoteAuth ?? "oauth")
        : agent.remoteAuth,
    supportTier: agent.supportTier ?? defaultTier,
    verification: agent.verification ?? {
      evidence,
      checkedOn: agent.source?.checkedOn ?? LAST_AGENT_REGISTRY_CHECK_DATE,
      clientVersion: null,
      platforms: [],
      reference:
        evidence === "PACKAGE_CONFORMANCE"
          ? "packages/agent-plugin/src/__tests__/build.test.ts"
          : (agent.source?.url ?? `https://lyrashieldai.com/docs/integrations/${agent.docsSlug}`),
      receipt: null,
    },
  } satisfies RegistryAgentEntry
})
