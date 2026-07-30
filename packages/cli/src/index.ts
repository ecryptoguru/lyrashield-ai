import process from "node:process"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import minimist from "minimist"
import { createOutput } from "./output.js"
import type { Output } from "./output.js"

// Command handlers
import { handleLogin } from "./commands/login.js"
import { handleLogout } from "./commands/logout.js"
import { handleUse } from "./commands/use.js"
import { handleAgents } from "./commands/agents.js"
import { handleDoctor } from "./commands/doctor.js"
import { handleInit } from "./commands/init.js"
import { handleInstall } from "./commands/install.js"
import { handleUninstall } from "./commands/uninstall.js"
import { handleScan } from "./commands/scan.js"
import { handleStatus } from "./commands/status.js"
import { handleFindings } from "./commands/findings.js"
import { handleExplain } from "./commands/explain.js"
import { handleFixPlan } from "./commands/fix-plan.js"
import { handleVerify } from "./commands/verify.js"
import { handleCheckDiff } from "./commands/check-diff.js"
import { handleGate } from "./commands/gate.js"
import { handleReport } from "./commands/report.js"
import { handleReadiness } from "./commands/readiness.js"
import { handleTargets } from "./commands/targets.js"
import { handleRules } from "./commands/rules.js"
import { handleHook } from "./commands/hook.js"

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

const COMMANDS: Record<string, (args: string[], output: Output) => Promise<number>> = {
  login: handleLogin,
  logout: handleLogout,
  use: handleUse,
  agents: handleAgents,
  doctor: handleDoctor,
  init: handleInit,
  install: handleInstall,
  uninstall: handleUninstall,
  scan: handleScan,
  status: handleStatus,
  findings: handleFindings,
  explain: handleExplain,
  "fix-plan": handleFixPlan,
  verify: handleVerify,
  "check-diff": handleCheckDiff,
  gate: handleGate,
  report: handleReport,
  readiness: handleReadiness,
  targets: handleTargets,
  rules: handleRules,
  hook: handleHook,
}

function usage(): string {
  return `lyrashield <command> [args]

Commands:
  login                Store an API key
  logout               Remove stored credentials
  use <workspace>      Set default workspace
  agents               List registry agents and detection state
  doctor               Diagnose configuration and API reachability
  init                 Detect and configure installed agents
  install <agent>      Configure a single agent
  uninstall <agent>    Remove LyraShield entry for a single agent
  scan                 Start a security scan
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
  hook install         Install a pre-commit hook

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

  return handler(rest, output)
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    const output = createOutput({ json: !!process.argv.includes("--json") })
    output.fail(err instanceof Error ? err.message : String(err), 1)
  }
)
