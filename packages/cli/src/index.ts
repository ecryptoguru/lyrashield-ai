import process from "node:process"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import minimist from "minimist"
import { createOutput } from "./output.js"
import type { Output } from "./output.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function getVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(path.join(__dirname, "..", "package.json"), "utf-8")) as {
      version: string
    }
    return pkg.version
  } catch {
    return "0.1.0"
  }
}

type CommandHandler = (args: string[], output: Output) => Promise<number>
type CommandThunk = () => Promise<CommandHandler>

const COMMANDS: Record<string, CommandThunk> = {
  login: () => import("./commands/login.js").then((m) => m.handleLogin),
  logout: () => import("./commands/logout.js").then((m) => m.handleLogout),
  use: () => import("./commands/use.js").then((m) => m.handleUse),
  agents: () => import("./commands/agents.js").then((m) => m.handleAgents),
  doctor: () => import("./commands/doctor.js").then((m) => m.handleDoctor),
  init: () => import("./commands/init.js").then((m) => m.handleInit),
  install: () => import("./commands/install.js").then((m) => m.handleInstall),
  uninstall: () => import("./commands/uninstall.js").then((m) => m.handleUninstall),
  scan: () => import("./commands/scan.js").then((m) => m.handleScan),
  "pr-scan": () => import("./commands/pr-scan.js").then((m) => m.handlePrScan),
  status: () => import("./commands/status.js").then((m) => m.handleStatus),
  findings: () => import("./commands/findings.js").then((m) => m.handleFindings),
  explain: () => import("./commands/explain.js").then((m) => m.handleExplain),
  "fix-plan": () => import("./commands/fix-plan.js").then((m) => m.handleFixPlan),
  verify: () => import("./commands/verify.js").then((m) => m.handleVerify),
  "check-diff": () => import("./commands/check-diff.js").then((m) => m.handleCheckDiff),
  gate: () => import("./commands/gate.js").then((m) => m.handleGate),
  report: () => import("./commands/report.js").then((m) => m.handleReport),
  readiness: () => import("./commands/readiness.js").then((m) => m.handleReadiness),
  project: () => import("./commands/project.js").then((m) => m.handleProject),
  targets: () => import("./commands/targets.js").then((m) => m.handleTargets),
  rules: () => import("./commands/rules.js").then((m) => m.handleRules),
  hook: () => import("./commands/hook.js").then((m) => m.handleHook),
  approvals: () => import("./commands/approvals.js").then((m) => m.handleApprovals),
  mcp: () => import("./commands/mcp.js").then((m) => m.handleMcp),
}

function usage(): string {
  return `lyrashield <command> [args]

Commands:
  login [--oauth]      Store an API key or complete OAuth device login
  logout               Remove stored credentials
  use <workspace>      Set default workspace
  agents               List registry agents and detection state
  doctor               Diagnose configuration and API reachability
  init                 Detect and configure installed agents
  install <agent>      Configure a single agent
  uninstall <agent>    Remove LyraShield entry for a single agent
  project              Manage the default project
  scan                 Start a security scan
  pr-scan              Start a PR-focused scan (alias for scan --goal CHECK_PR)
  status [scanId]      Show scan status
  findings             List findings
  explain <findingId>  Explain a finding
  fix-plan <findingId> Generate a fix plan
  verify <findingId>   Queue a retest
  check-diff           Local advisory diff check
  gate                 CI gate (local + findings)
  report               Create or list reports
  readiness            Launch readiness
  targets              List or create targets
  rules add <agent>    Write an agent rules file
  rules remove <agent> Remove an agent rules file
  rules check          Validate agent rule checksums
  hook install         Install a pre-commit hook
  approvals            List, create, approve, or deny agent approvals
  mcp call <tool>      Call a remote MCP tool

Global flags:
  --json               Machine-readable output
  --version            Print version
  --help               Show this message
  NO_COLOR=1           Disable colors`
}

async function main(argv: string[]): Promise<number> {
  const parsed = minimist(argv, {
    boolean: ["json", "help", "version"],
    string: [],
    alias: { v: "version", h: "help" },
    default: { json: false, help: false, version: false },
    stopEarly: true,
  })

  const isJson = parsed.json || argv.includes("--json")
  const isHelp = parsed.help || argv.includes("--help")
  const output = createOutput({ json: isJson })

  if (parsed.version) {
    const version = await getVersion()
    output.result(`lyrashield-cli/${version}`)
    return 0
  }

  if (isHelp || !parsed._.length) {
    output.notice(usage())
    return 0
  }

  const [command, ...rest] = parsed._ as string[]
  if (!command) {
    output.error("No command provided.")
    output.notice(usage())
    return 2
  }
  const handler = COMMANDS[command]
  if (!handler) {
    output.error(`Unknown command: ${command}`)
    output.notice(usage())
    return 2
  }

  return (await handler())(rest, output)
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    const output = createOutput({ json: !!process.argv.includes("--json") })
    let exitCode = 4
    if (err && typeof err === "object" && "status" in err && typeof err.status === "number") {
      if (err.status === 401 || err.status === 403) exitCode = 3
      else if (err.status === 429) exitCode = 5
    }
    output.fail(err instanceof Error ? err.message : String(err), exitCode)
  }
)
