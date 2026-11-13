/**
 * AST-based function-size measurement.
 *
 * Why this exists: decomposition debt targets are expressed per function —
 * "keep functions below 250 lines". A whole-file line count is NOT the metric:
 * a file may hold many small functions, and a small file may hide one oversized
 * function. This module measures the size of every function node in a source
 * file so the limit is enforced on the unit the debt item names.
 *
 * Counting rules (fixed — do not reinterpret per call):
 *  1. Counted nodes: FunctionDeclaration, FunctionExpression, and
 *     ArrowFunctionExpression only (ESLint's `:function` selector). Object and
 *     class methods are FunctionExpression values; getters/setters count the
 *     same way. Class bodies, `static {}` blocks, and bare blocks are not
 *     functions.
 *  2. A function's span is the line range from the line of its first token
 *     (the `function`/`async` keyword, the arrow parameter list, or the method
 *     name) through the line of its closing `}`, inclusive. For an arrow whose
 *     body is a single expression, the span ends on that expression's line.
 *  3. Inside the span, a line counts when it contains at least one character
 *     that is neither whitespace nor part of a comment node. Blank lines and
 *     comment-only lines are skipped; a line mixing code and a trailing comment
 *     counts. This matches `max-lines-per-function` with
 *     `{ skipBlankLines: true, skipComments: true }` — the same convention as
 *     eslint.size.config.mjs, whose advisory threshold is 150.
 *  4. Nested functions each get their own measurement; a helper extracted for
 *     readability still counts its own body.
 *  5. JSX inside a component function counts toward that function — extracting
 *     JSX into child components is the intended way to shrink render bodies.
 *
 * Usage:
 *   const results = await measureFunctionSizes("path/to/file.ts")
 *   // [{ name, kind, line, endLine, lines }]
 */
import { readFile } from "node:fs/promises"
import { Linter } from "eslint"
import nextVitals from "eslint-config-next/core-web-vitals"

const tsConfig = nextVitals.find((config) => config.name === "next/typescript")
const tsParser = tsConfig.languageOptions.parser

/** Maximum counted lines for one function (the v23 decomposition target). */
const FUNCTION_SIZE_LIMIT = 250
export { FUNCTION_SIZE_LIMIT }

/**
 * Mark lines that carry only comments — every non-whitespace character on the
 * line falls inside a comment node. Blank lines are handled separately.
 */
function commentOnlyLines(sourceCode) {
  const text = sourceCode.getText()
  const lineStarts = [0]
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") lineStarts.push(index + 1)
  }
  const commentRanges = sourceCode
    .getAllComments()
    .map((comment) => [comment.range[0], comment.range[1]])

  const marked = new Set()
  for (let lineIndex = 0; lineIndex < lineStarts.length; lineIndex++) {
    const start = lineStarts[lineIndex]
    const end = lineIndex + 1 < lineStarts.length ? lineStarts[lineIndex + 1] - 1 : text.length
    let covered = true
    let hasContent = false
    for (let index = start; index < end; index++) {
      const char = text[index]
      if (char === " " || char === "\t" || char === "\r") continue
      hasContent = true
      if (!commentRanges.some(([from, to]) => index >= from && index < to)) {
        covered = false
        break
      }
    }
    if (hasContent && covered) marked.add(lineIndex + 1) // 1-based line number
  }
  return marked
}

function functionName(node) {
  if (node.id?.name) return node.id.name
  const parent = node.parent
  switch (parent?.type) {
    case "VariableDeclarator":
      return parent.id.type === "Identifier" ? parent.id.name : "<destructured>"
    case "Property":
    case "PropertyDefinition":
    case "MethodDefinition":
      return parent.key?.name ?? parent.key?.value ?? "<computed>"
    case "AssignmentExpression":
      return parent.left?.name ?? "<assigned>"
    case "ExportDefaultDeclaration":
      return "<default export>"
    default:
      return "<anonymous>"
  }
}

/**
 * Measure every function in one source string.
 *
 * @param {object} params
 * @param {string} params.code source text
 * @param {string} params.filename used only for parser mode selection
 *   (`.tsx`/`.jsx` enable JSX)
 * @returns {Array<{name: string, kind: string, line: number, endLine: number, lines: number}>}
 */
export function measureSourceFunctions({ code, filename }) {
  const nodes = []
  let sourceCode = null
  const rule = {
    create(context) {
      sourceCode = context.sourceCode
      return {
        ":function"(node) {
          nodes.push(node)
        },
      }
    },
  }
  const linter = new Linter()
  const messages = linter.verify(
    code,
    [
      {
        files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts", "**/*.js", "**/*.jsx", "**/*.mjs"],
        languageOptions: {
          parser: tsParser,
          parserOptions: { sourceType: "module", ecmaFeatures: { jsx: true } },
        },
        plugins: { measure: { rules: { size: rule } } },
        rules: { "measure/size": "warn" },
      },
    ],
    { filename }
  )
  const fatal = messages.find((message) => message.fatal)
  if (fatal) {
    throw new Error(`cannot parse ${filename}: ${fatal.message} (line ${fatal.line})`)
  }

  const commentOnly = commentOnlyLines(sourceCode)
  return nodes.map((node) => {
    let lines = 0
    for (let line = node.loc.start.line; line <= node.loc.end.line; line++) {
      if (sourceCode.lines[line - 1].trim() === "") continue
      if (commentOnly.has(line)) continue
      lines++
    }
    return {
      name: functionName(node),
      kind: node.type,
      line: node.loc.start.line,
      endLine: node.loc.end.line,
      lines,
    }
  })
}

/** Measure every function in a file on disk. Same return shape as above. */
export async function measureFunctionSizes(filePath) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- callers pass fixed repo-relative paths
  const code = await readFile(filePath, "utf8")
  return measureSourceFunctions({ code, filename: filePath })
}

/** Report entries whose counted size exceeds the shared limit. */
export function oversizedFunctions(measurements, limit = FUNCTION_SIZE_LIMIT) {
  return measurements.filter((entry) => entry.lines > limit)
}
