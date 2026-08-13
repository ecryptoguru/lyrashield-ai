export type AiDataExposureFinding = {
  id: string
  title: string
  severity: "HIGH" | "MEDIUM"
  cwe: string
  description: string
  remediation: string
  line: number
  snippet: string
  controlIds: number[]
}

export type AiDataExposureSource = { path: string; content: string }

function finding(
  path: string,
  line: number,
  suffix: string,
  title: string,
  severity: "HIGH" | "MEDIUM",
  cwe: string,
  description: string,
  remediation: string,
  snippet: string,
  controlIds: number[]
): AiDataExposureFinding {
  return {
    id: `ai-data-exposure-${suffix}-${path}-${line}`,
    title,
    severity,
    cwe,
    description,
    remediation,
    line,
    snippet: snippet.slice(0, 240),
    controlIds,
  }
}

export function scanAiDataExposure(source: AiDataExposureSource): AiDataExposureFinding[] {
  const findings: AiDataExposureFinding[] = []
  for (const [index, line] of source.content.split("\n").entries()) {
    const lineNumber = index + 1
    const isLogger =
      /\b(?:console\.(?:log|info|debug|warn)|logger\.(?:info|debug|warn|error))\s*\(/i.test(line)
    if (isLogger && /\b(?:prompt|messages?|response|completion)\b/i.test(line)) {
      findings.push(
        finding(
          source.path,
          lineNumber,
          "raw-llm-log",
          "Raw AI prompt or response logged",
          "HIGH",
          "CWE-532",
          "A logger call includes prompt, message, response, or completion content.",
          "Redact or omit AI prompt and response content from logs; retain only approved metadata.",
          line,
          [33, 40]
        )
      )
    }
    if (/\b(?:write-all|\*:\s*(?:write|admin)|"\*"|'\*')\b/i.test(line)) {
      findings.push(
        finding(
          source.path,
          lineNumber,
          "mcp-wildcard-permission",
          "Wildcard or write-all MCP permission",
          "HIGH",
          "CWE-250",
          "An MCP/tool manifest declares a wildcard or write-all permission.",
          "Replace broad permissions with the smallest read/write capability set needed by each tool.",
          line,
          [42]
        )
      )
    }
    if (
      /\b(?:exec|spawn|command|shell)\b/i.test(line) &&
      /\b(?:tool|execute|command|shell)\b/i.test(line) &&
      !/\b(?:require_?approval|approvalRequired)\s*[:=]\s*true\b/i.test(line)
    ) {
      findings.push(
        finding(
          source.path,
          lineNumber,
          "command-without-approval",
          "Tool command execution lacks explicit approval",
          "HIGH",
          "CWE-250",
          "A tool or command execution declaration does not show an explicit approval requirement.",
          "Require explicit approval before tool commands can execute and restrict the permitted command set.",
          line,
          [44]
        )
      )
    }
    if (
      /\b(?:addDocuments|fromDocuments|upsert|ingest)\s*\(/i.test(line) &&
      /\b(?:vector|document|embedding|rag)/i.test(line) &&
      !/\b(?:tenant|workspace|user|accessControl|acl|authorization)\b/i.test(line)
    ) {
      findings.push(
        finding(
          source.path,
          lineNumber,
          "rag-ingestion-access-control",
          "RAG ingestion lacks a declared access-control scope",
          "MEDIUM",
          "CWE-284",
          "A vector/RAG ingestion call does not show a tenant, user, or access-control scope.",
          "Declare and enforce an access-control scope before ingesting documents into a shared retrieval store.",
          line,
          [40]
        )
      )
    }
    if (/\b(?:inputSchema|parameters)\s*:\s*\{\s*\}/i.test(line)) {
      findings.push(
        finding(
          source.path,
          lineNumber,
          "empty-tool-input-schema",
          "Tool declares an empty input schema",
          "MEDIUM",
          "CWE-20",
          "A tool declaration exposes an explicitly empty input schema.",
          "Define and validate the allowed tool input fields before execution.",
          line,
          [42]
        )
      )
    }
  }
  return findings
}
