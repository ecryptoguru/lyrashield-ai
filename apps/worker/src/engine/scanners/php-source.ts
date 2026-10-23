// security-scan-skip-file: passive rules recognize dangerous PHP constructs
import type { EngineVulnerability } from "../output-parser"
import { closingToken, splitPhpArguments, tokenizePhp, type PhpToken } from "./php-source-lexer"
import { phpExpressionFlow, type PhpContext, type PhpLocals } from "./php-source-flow"

export const PHP_SOURCE_RULE_VERSION = "php-source-local-flow/1.0.0"
const MAX_BYTES = 512 * 1024
const LIMITATION =
  "PHP analysis covers bounded lexical request-to-sink and local-variable flows only; cross-file, function-return, authorization, CSRF and session behavior remain unassessed"

interface Rule {
  context: PhpContext
  names: string[]
  cwe: string
  title: string
  remediation: string
}

const RULES: Rule[] = [
  {
    context: "command",
    names: ["system", "exec", "shell_exec", "passthru", "popen", "proc_open"],
    cwe: "CWE-78",
    title: "Request input reaches PHP command execution",
    remediation:
      "Replace shell execution with a fixed operation and validated arguments. If a shell is essential, review argument boundaries and escaping for the actual shell and platform.",
  },
  {
    context: "sql",
    names: [
      "query",
      "exec",
      "prepare",
      "mysqli_query",
      "mysql_query",
      "pg_query",
      "select",
      "selectraw",
      "whereraw",
      "statement",
      "unprepared",
    ],
    cwe: "CWE-89",
    title: "Request input reaches a PHP SQL statement",
    remediation:
      "Use prepared statements with bound values. Keep SQL identifiers and query structure in a fixed server-side allowlist; preparing interpolated SQL does not make it safe.",
  },
  {
    context: "deserialize",
    names: ["unserialize"],
    cwe: "CWE-502",
    title: "Untrusted PHP deserialization",
    remediation:
      "Avoid deserializing request data. Prefer a bounded JSON schema. allowed_classes=false reduces object construction but is not a general guarantee for untrusted serialized data.",
  },
  {
    context: "include",
    names: ["include", "include_once", "require", "require_once"],
    cwe: "CWE-98",
    title: "Request input reaches PHP file inclusion",
    remediation:
      "Choose includes from a fixed server-side map of permitted files. Do not build include paths from request values.",
  },
  {
    context: "path",
    names: ["readfile", "fopen", "file_get_contents", "file_put_contents", "unlink"],
    cwe: "CWE-22",
    title: "Request input controls a PHP filesystem path",
    remediation:
      "Use fixed file identifiers and enforce canonical path containment, authorization and filesystem permissions. basename alone does not establish containment.",
  },
  {
    context: "upload",
    names: ["move_uploaded_file"],
    cwe: "CWE-434",
    title: "Request input controls an uploaded file destination",
    remediation:
      "Generate the destination name server-side, store outside executable/public directories and verify size, type, authorization and download handling. This rule only assesses destination flow.",
  },
  {
    context: "xml",
    names: ["simplexml_load_string", "loadxml"],
    cwe: "CWE-611",
    title: "Untrusted XML parsed with entity or DTD loading",
    remediation:
      "Disable entity substitution and external DTD loading for untrusted XML; enforce bounded input and offline resource handling. LIBXML_NONET alone does not block local file entities.",
  },
  {
    context: "ssrf",
    names: ["curl_init", "file_get_contents", "fopen", "curl_setopt"],
    cwe: "CWE-918",
    title: "Request input reaches a PHP outbound request target",
    remediation:
      "Use a fixed destination allowlist, validate resolved addresses and redirects, and enforce egress restrictions. URL syntax validation alone does not prevent SSRF.",
  },
]

function ruleArgument(rule: Rule, name: string, args: PhpToken[][]): PhpToken[] | undefined {
  if (
    rule.context === "xml" &&
    !args
      .slice(1)
      .flat()
      .some((t) => ["LIBXML_NOENT", "LIBXML_DTDLOAD"].includes(t.text))
  )
    return
  if (rule.context === "ssrf" && name === "curl_setopt") {
    return args[1]?.some((t) => t.text === "CURLOPT_URL") ? args[2] : undefined
  }
  if (rule.context === "upload") return args[1]
  if (rule.context === "sql" && ["mysqli_query", "pg_query"].includes(name))
    return args.length > 1 ? args[1] : args[0]
  return args[0]
}

function buildFinding(rule: Rule, path: string, token: PhpToken): EngineVulnerability {
  return {
    id: `php-${rule.context}-${path}-${token.line}`,
    title: `${rule.title} in ${path}:${token.line}`,
    severity: rule.context === "path" || rule.context === "ssrf" ? "medium" : "high",
    timestamp: new Date().toISOString(),
    target: path,
    cwe: rule.cwe,
    finding_class: "php_source_flow",
    description: `${rule.title}. A bounded static input-flow pattern was detected; runtime reachability and exploitability require independent verification.`,
    technical_analysis: `${PHP_SOURCE_RULE_VERSION}; lexical/local-variable flow into ${token.text} at ${path}:${token.line}. No PHP code was executed.`,
    assumptions: LIMITATION,
    impact:
      "If reachable without effective controls, untrusted input may cross the identified operation boundary. Deployment, privileges and external controls determine the actual impact.",
    remediation_steps: rule.remediation,
    dependency_metadata: {
      rule_version: PHP_SOURCE_RULE_VERSION,
      evidence_scope: "source-local-flow",
      analysis: "passive",
      sink: token.text,
      rule: rule.context,
    },
    code_locations: [{ file: path, start_line: token.line, label: rule.title }],
  }
}

function commandArgumentFlows(args: PhpToken[][], locals: PhpLocals, issues: string[]): boolean {
  const command = args[0] ?? []
  if (command[0]?.text !== "[" || closingToken(command, 0) !== command.length - 1)
    return phpExpressionFlow(command, locals, issues).has("command")
  const argv = splitPhpArguments(command.slice(1, -1))
  const executable = argv[0] ?? []
  // Escaping a shell argument does not establish a trusted executable identity.
  if (phpExpressionFlow(executable, locals, issues).has("path")) return true
  const name =
    executable.length === 1 && executable[0]?.kind === "string"
      ? executable[0].text.slice(1, -1)
      : undefined
  const shell =
    /(?:^|[\\/])(?:sh|bash|dash|zsh|ksh|fish|csh|tcsh|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?)$/i
  // env can dispatch an attacker-selected executable, including a shell.
  if (shell.test(name ?? "") || /(?:^|[\\/])env$/.test(name ?? ""))
    return phpExpressionFlow(command, locals, issues).has("path")
  issues.push(
    "PHP proc_open argv-array executable resolution and command-specific argument injection remain unassessed"
  )
  return false
}

function inspectStatement(
  tokens: PhpToken[],
  locals: PhpLocals,
  path: string,
  issues: string[]
): EngineVulnerability[] {
  const findings: EngineVulnerability[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.kind !== "word") continue
    const name = token.text.toLowerCase()
    const isMethod = ["->", "?->", "::"].includes(tokens[i - 1]?.text ?? "")
    const rules = RULES.filter(
      (rule) =>
        rule.names.includes(name) &&
        // exec() is a shell builtin; PDO exec() is SQL. Generic select/query are method-only.
        !(rule.context === "command" && isMethod) &&
        !(
          rule.context === "sql" &&
          [
            "exec",
            "query",
            "prepare",
            "select",
            "selectraw",
            "whereraw",
            "statement",
            "unprepared",
          ].includes(name) &&
          !isMethod
        )
    )
    if (!rules.length) continue
    const hasParens = tokens[i + 1]?.text === "("
    if (!hasParens && !rules.some((rule) => rule.context === "include")) continue
    if (["function", "fn"].includes(tokens[i - 1]?.text.toLowerCase() ?? "")) continue
    const end = hasParens ? closingToken(tokens, i + 1) : tokens.length
    if (end < 0) {
      issues.push("Unsupported unbalanced PHP sink call")
      continue
    }
    const args = hasParens ? splitPhpArguments(tokens.slice(i + 2, end)) : [tokens.slice(i + 1)]
    for (const rule of rules) {
      const argument = ruleArgument(rule, name, args)
      const flows =
        rule.context === "command" && name === "proc_open"
          ? commandArgumentFlows(args, locals, issues)
          : argument && phpExpressionFlow(argument, locals, issues).has(rule.context)
      if (flows) findings.push(buildFinding(rule, path, token))
    }
  }
  return findings
}

function updateLocals(
  tokens: PhpToken[],
  locals: PhpLocals,
  issues: string[],
  conditional: boolean
): void {
  if (tokens[0]?.kind !== "variable" || !["=", ".="].includes(tokens[1]?.text ?? "")) return
  const flow = phpExpressionFlow(tokens.slice(2), locals, issues)
  // Only definite straight-line replacement can remove a previous possible value.
  if (conditional || tokens[1]?.text === ".=") {
    for (const context of locals.get(tokens[0].text) ?? []) flow.add(context)
  }
  locals.set(tokens[0].text, flow)
}

export function analyzePhpSource(
  source: string,
  path: string
): { findings: EngineVulnerability[]; issues: string[] } {
  const issues = [LIMITATION]
  if (Buffer.byteLength(source) > MAX_BYTES)
    return { findings: [], issues: [...issues, `PHP source byte limit (${MAX_BYTES}) exceeded`] }
  const tokens = tokenizePhp(source, issues)
  const locals: PhpLocals = new Map()
  const findings: EngineVulnerability[] = []
  let statement: PhpToken[] = []
  const scopes: { outerLocals?: PhpLocals; conditionalDepth: number }[] = []
  let conditionalDepth = 0
  let depth = 0
  let statementBounded = false
  for (const token of tokens) {
    if (token.kind === "variable" && statement.at(-1)?.text === "$")
      issues.push("Unsupported PHP variable-variable flow")
    if (["(", "["].includes(token.text)) depth++
    if ([")", "]"].includes(token.text)) depth--
    if (["{", "}", ";"].includes(token.text) && depth === 0) {
      if (!statementBounded) {
        findings.push(...inspectStatement(statement, locals, path, issues))
        updateLocals(statement, locals, issues, conditionalDepth > 0)
      }
      if (token.text === "{") {
        const functionScope = statement.some((part) => part.text.toLowerCase() === "function")
        scopes.push({
          conditionalDepth,
          ...(functionScope ? { outerLocals: new Map(locals) } : {}),
        })
        if (functionScope) {
          locals.clear()
          conditionalDepth = 0
        } else conditionalDepth++
      } else if (token.text === "}") {
        const scope = scopes.pop()
        conditionalDepth = scope?.conditionalDepth ?? 0
        if (scope?.outerLocals) {
          locals.clear()
          for (const [name, flow] of scope.outerLocals) locals.set(name, flow)
        }
      }
      statement = []
      statementBounded = false
      if (findings.length >= 100) {
        issues.push("PHP source finding limit (100) reached")
        break
      }
    } else if (statement.length < 2048) statement.push(token)
    else {
      statementBounded = true
      issues.push("PHP statement token limit (2048) reached")
    }
  }
  if (!statementBounded) findings.push(...inspectStatement(statement, locals, path, issues))
  if (depth !== 0) issues.push("Unsupported unbalanced PHP source syntax")
  return {
    findings: [...new Map(findings.map((f) => [f.id, f])).values()].slice(0, 100),
    issues: [...new Set(issues)],
  }
}
