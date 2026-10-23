import { closingToken, splitPhpArguments, type PhpToken } from "./php-source-lexer"

export type PhpContext =
  "command" | "sql" | "deserialize" | "include" | "path" | "upload" | "xml" | "ssrf"
export type PhpFlow = Set<PhpContext>
export type PhpLocals = Map<string, PhpFlow>
const CONTEXTS: PhpContext[] = [
  "command",
  "sql",
  "deserialize",
  "include",
  "path",
  "upload",
  "xml",
  "ssrf",
]
const REQUEST = /^\$_(?:GET|POST|REQUEST|COOKIE|FILES|SERVER)$/

/** A PHP double-quoted dollar is literal after an odd number of backslashes. */
function interpolatedVariables(text: string): string[] {
  return [...text.matchAll(/\$[a-zA-Z_]\w*/g)].flatMap((match) => {
    let slashes = 0
    for (let i = match.index - 1; i >= 0 && text[i] === "\\"; i--) slashes++
    return slashes % 2 === 0 ? [match[0]] : []
  })
}

function literalAllowlist(tokens: PhpToken[]): boolean {
  if (tokens[0]?.text !== "[") return false
  const end = closingToken(tokens, 0)
  if (
    end < 0 ||
    tokens[end + 1]?.text !== "[" ||
    closingToken(tokens, end + 1) !== tokens.length - 1
  )
    return false
  return tokens
    .slice(1, end)
    .every(
      (token) =>
        [",", "=>"].includes(token.text) ||
        (token.kind === "string" && !token.text.includes("$")) ||
        /^\d+$/.test(token.text)
    )
}

/** Forward local flow only. Sanitizers are sink-context specific and explicit. */
export function phpExpressionFlow(
  tokens: PhpToken[],
  locals: PhpLocals,
  issues: string[],
  depth = 0
): PhpFlow {
  const flow: PhpFlow = new Set()
  if (depth > 32) {
    if (!issues.includes("PHP expression nesting limit reached"))
      issues.push("PHP expression nesting limit reached")
    return flow
  }
  if (literalAllowlist(tokens)) return flow
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.text === "(") {
      const end = closingToken(tokens, i)
      if (end < 0) {
        issues.push("Unsupported unbalanced PHP expression")
        break
      }
      for (const context of phpExpressionFlow(tokens.slice(i + 1, end), locals, issues, depth + 1))
        flow.add(context)
      i = end
    } else if (token.kind === "word" && tokens[i + 1]?.text === "(") {
      const end = closingToken(tokens, i + 1)
      if (end < 0) {
        issues.push("Unsupported unbalanced PHP call")
        break
      }
      const name = token.text.toLowerCase()
      const args = splitPhpArguments(tokens.slice(i + 2, end))
      const nested = phpExpressionFlow(args.flat(), locals, issues, depth + 1)
      if (
        name === "request" ||
        name === "filter_input" ||
        (name === "file_get_contents" &&
          ["'php://input'", '"php://input"'].includes(args[0]?.[0]?.text ?? "")) ||
        (["input", "query"].includes(name) && tokens[i - 2]?.text === "$request")
      ) {
        for (const context of CONTEXTS) nested.add(context)
      }
      if (name === "escapeshellarg") nested.delete("command")
      if (name === "intval") nested.delete("sql")
      for (const context of nested) flow.add(context)
      i = end
    } else if (token.kind === "variable") {
      for (const context of REQUEST.test(token.text) ? CONTEXTS : (locals.get(token.text) ?? []))
        flow.add(context)
    } else if (token.kind === "string" && token.text.startsWith('"')) {
      for (const variable of interpolatedVariables(token.text)) {
        for (const context of REQUEST.test(variable) ? CONTEXTS : (locals.get(variable) ?? []))
          flow.add(context)
      }
    }
  }
  return flow
}
