import ts from "typescript"
import { computeDefinitionHash } from "./canonicalize"
import { sha256 } from "./hash"
import { getLineNumber } from "./utils"
import type {
  ImperativeDiscoveryResult,
  WebMcpScanFile,
  WebMcpSpecDriftFinding,
  WebMcpToolSurface,
} from "./types"

function staticMemberName(node: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node)) return getStringLiteralValue(node.argumentExpression)
  return null
}

function isDocumentOrNavigator(node: ts.Expression): boolean {
  return ts.isIdentifier(node) && (node.text === "document" || node.text === "navigator")
}

function classifyRegisterToolMember(expr: ts.Expression): "confirmed" | "ambiguous" | null {
  if (!ts.isPropertyAccessExpression(expr) && !ts.isElementAccessExpression(expr)) return null

  const method = staticMemberName(expr)
  const context = expr.expression
  if (ts.isIdentifier(context) && context.text === "modelContext") {
    return method === "registerTool" || method === null ? "ambiguous" : null
  }
  if (!ts.isPropertyAccessExpression(context) && !ts.isElementAccessExpression(context)) return null

  const contextName = staticMemberName(context)
  if (!isDocumentOrNavigator(context.expression)) return null
  if (contextName === "modelContext" && method === "registerTool") return "confirmed"
  if (contextName === "modelContext" || contextName === null) return "ambiguous"
  return null
}

function classifyRegisterToolCall(node: ts.Node): "confirmed" | "ambiguous" | null {
  if (!ts.isCallExpression(node)) return null
  const direct = classifyRegisterToolMember(node.expression)
  if (direct) return direct

  const expr = node.expression
  if (!ts.isPropertyAccessExpression(expr) && !ts.isElementAccessExpression(expr)) return null
  const method = staticMemberName(expr)
  if (
    (method === "call" || method === "apply") &&
    classifyRegisterToolMember(expr.expression) !== null
  ) {
    return "ambiguous"
  }
  if (
    method === "apply" &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "Reflect" &&
    node.arguments[0] &&
    classifyRegisterToolMember(node.arguments[0]) !== null
  ) {
    return "ambiguous"
  }
  return null
}

function scriptKindFor(file: WebMcpScanFile): ts.ScriptKind {
  switch (file.extension.toLowerCase()) {
    case ".jsx":
      return ts.ScriptKind.JSX
    case ".tsx":
      return ts.ScriptKind.TSX
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS
    default:
      return ts.ScriptKind.TS
  }
}

function getTextOf(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile)
}

function getStringLiteralValue(
  node: ts.Node | undefined,
  _sourceFile?: ts.SourceFile
): string | null {
  if (node && ts.isStringLiteral(node)) return node.text
  if (node && ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return null
}

function getBooleanLiteralValue(node: ts.Node | undefined): boolean | null {
  if (!node) return null
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  return null
}

function getPropertyValue(
  objectLiteral: ts.ObjectLiteralExpression,
  name: string,
  _sourceFile: ts.SourceFile
): ts.Expression | undefined {
  for (const prop of objectLiteral.properties) {
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === name) {
      return prop.name
    }
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === name) {
      return prop.initializer
    }
    if (ts.isPropertyAssignment(prop) && ts.isStringLiteral(prop.name) && prop.name.text === name) {
      return prop.initializer
    }
  }
  return undefined
}

function getNumberLiteralValue(node: ts.Node | undefined): number | null {
  return node && ts.isNumericLiteral(node) ? Number(node.text) : null
}

function getPropertyString(
  objectLiteral: ts.ObjectLiteralExpression,
  name: string,
  sourceFile: ts.SourceFile
): string | null {
  const value = getPropertyValue(objectLiteral, name, sourceFile)
  if (!value) return null
  return getStringLiteralValue(value, sourceFile)
}

function getPropertyBoolean(
  objectLiteral: ts.ObjectLiteralExpression,
  name: string,
  sourceFile: ts.SourceFile
): boolean | null {
  const value = getPropertyValue(objectLiteral, name, sourceFile)
  if (!value) return null
  return getBooleanLiteralValue(value)
}

function extractStringArray(node: ts.Node, sourceFile: ts.SourceFile): string[] | null {
  if (ts.isArrayLiteralExpression(node)) {
    const out: string[] = []
    for (const element of node.elements) {
      const v = getStringLiteralValue(element, sourceFile)
      if (v === null) return null
      out.push(v)
    }
    return out
  }
  return null
}

function extractExposedTo(
  node: ts.Expression | undefined,
  sourceFile: ts.SourceFile
): string[] | "dynamic" | null {
  if (!node) return null
  const arr = extractStringArray(node, sourceFile)
  if (arr !== null) return arr
  const text = getStringLiteralValue(node, sourceFile)
  if (text !== null) return [text]
  return "dynamic"
}

function extractInputSchema(
  node: ts.Expression | undefined,
  sourceFile: ts.SourceFile
): {
  type: string
  properties?: {
    name: string
    type: string
    required: boolean
    description?: string
    bounded?: boolean
  }[]
  additionalProperties?: boolean | "unknown"
  required?: string[]
} {
  if (!node) return { type: "unknown", additionalProperties: "unknown" }

  if (ts.isObjectLiteralExpression(node)) {
    const properties: {
      name: string
      type: string
      required: boolean
      description?: string
      bounded?: boolean
    }[] = []
    const requiredNode = getPropertyValue(node, "required", sourceFile)
    const required = requiredNode ? (extractStringArray(requiredNode, sourceFile) ?? []) : []
    let additionalProperties: boolean | "unknown" = true

    const props = getPropertyValue(node, "properties", sourceFile)
    if (props && ts.isObjectLiteralExpression(props)) {
      for (const p of props.properties) {
        if (!ts.isPropertyAssignment(p)) continue
        const name = ts.isIdentifier(p.name)
          ? p.name.text
          : ts.isStringLiteral(p.name)
            ? p.name.text
            : ""
        if (!name) continue
        const schema = extractInputSchema(p.initializer, sourceFile)
        const propertyObject = ts.isObjectLiteralExpression(p.initializer)
          ? p.initializer
          : undefined
        const description = propertyObject
          ? (getPropertyString(propertyObject, "description", sourceFile) ?? undefined)
          : undefined
        const maxLength = propertyObject
          ? getNumberLiteralValue(getPropertyValue(propertyObject, "maxLength", sourceFile))
          : null
        const maxItems = propertyObject
          ? getNumberLiteralValue(getPropertyValue(propertyObject, "maxItems", sourceFile))
          : null
        properties.push({
          name,
          type: schema.type,
          required: required.includes(name),
          description,
          bounded: maxLength !== null || maxItems !== null,
        })
      }
    }

    const type = getPropertyString(node, "type", sourceFile) ?? "object"
    const ap = getPropertyValue(node, "additionalProperties", sourceFile)
    if (ap) {
      const bool = getBooleanLiteralValue(ap)
      additionalProperties = bool ?? "unknown"
    }

    return {
      type,
      properties: properties.length ? properties : undefined,
      additionalProperties,
      required: required.length ? required : undefined,
    }
  }

  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text
    const obj = getTextOf(node.expression.expression, sourceFile)
    if ((obj === "z" || obj === "zod") && (method === "object" || method === "infer")) {
      const arg = node.arguments[0]
      if (arg && ts.isObjectLiteralExpression(arg)) {
        return extractInputSchema(arg, sourceFile)
      }
    }
  }

  return { type: "unknown", additionalProperties: "unknown" }
}

function findExecute(
  objectLiteral: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  const exec = getPropertyValue(objectLiteral, "execute", sourceFile)
  if (!exec) return undefined
  if (ts.isArrowFunction(exec) || ts.isFunctionExpression(exec)) return exec
  return undefined
}

function analyzeNetworkCalls(
  execute: ts.ArrowFunction | ts.FunctionExpression,
  sourceFile: ts.SourceFile
): {
  methods: string[]
  returnsExternal: boolean
  forwardsCancellation: boolean
} {
  const methods: string[] = []
  let returnsExternal = false
  let networkCallCount = 0
  let cancellableCallCount = 0
  const callbackSignal = getCallbackSignalExpression(execute)

  function pushMethod(method: string) {
    if (!methods.includes(method)) methods.push(method)
  }

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callName = getTextOf(node.expression, sourceFile)
      if (callName === "fetch") {
        networkCallCount++
        const method = extractFetchMethod(node, sourceFile)
        pushMethod(method)
        if (callbackSignal && fetchForwardsSignal(node, sourceFile, callbackSignal)) {
          cancellableCallCount++
        }
      } else if (/^(axios|http|https)\./.test(callName)) {
        networkCallCount++
        const method = callName.split(".").pop() ?? "GET"
        pushMethod(method.toUpperCase())
      }
    }

    if (ts.isReturnStatement(node)) {
      if (node.expression) {
        const text = getTextOf(node.expression, sourceFile)
        if (/fetch|axios|response\.json|response\.text/.test(text)) {
          returnsExternal = true
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  if (execute.body) ts.forEachChild(execute.body, visit)

  return {
    methods,
    returnsExternal,
    forwardsCancellation: networkCallCount > 0 && cancellableCallCount === networkCallCount,
  }
}

function getCallbackSignalExpression(
  execute: ts.ArrowFunction | ts.FunctionExpression
): string | null {
  const options = execute.parameters[1]
  if (!options) return null
  if (ts.isIdentifier(options.name)) return `${options.name.text}.signal`
  if (ts.isObjectBindingPattern(options.name)) {
    for (const element of options.name.elements) {
      const sourceName =
        element.propertyName && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : ts.isIdentifier(element.name)
            ? element.name.text
            : null
      if (sourceName === "signal" && ts.isIdentifier(element.name)) return element.name.text
    }
  }
  return null
}

function extractFetchMethod(node: ts.CallExpression, sourceFile: ts.SourceFile): string {
  const options = node.arguments[1]
  if (!options) return "GET"
  if (ts.isObjectLiteralExpression(options)) {
    const methodProp = getPropertyValue(options, "method", sourceFile)
    if (methodProp) {
      const v = getStringLiteralValue(methodProp, sourceFile)
      if (v) return v.toUpperCase()
      return "UNKNOWN"
    }
    return "GET"
  }
  return "UNKNOWN"
}

function fetchForwardsSignal(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  callbackSignal: string
): boolean {
  const options = node.arguments[1]
  if (!options || !ts.isObjectLiteralExpression(options)) return false
  const signalProp = getPropertyValue(options, "signal", sourceFile)
  if (!signalProp) return false
  return getTextOf(signalProp, sourceFile) === callbackSignal
}

function detectBehavior(
  execute: ts.ArrowFunction | ts.FunctionExpression,
  sourceFile: ts.SourceFile,
  network: { methods: string[] }
): "read" | "ui-only" | "mutation" | "unknown" {
  if (network.methods.length > 0) {
    if (network.methods.includes("UNKNOWN")) return "unknown"
    const mutating = network.methods.filter((m) => ["POST", "PUT", "PATCH", "DELETE"].includes(m))
    if (mutating.length > 0) return "mutation"
    return "read"
  }

  const bodyText = execute.body ? getTextOf(execute.body, sourceFile) : ""
  const uiPatterns =
    /\b(setState|set[A-Z]\w*|dispatch|alert|confirm|prompt|showModal|postMessage|window\.open)\b/
  if (uiPatterns.test(bodyText)) return "ui-only"

  let hasPotentialSideEffect = false
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isAwaitExpression(node) ||
      ts.isDeleteExpression(node) ||
      ts.isPostfixUnaryExpression(node) ||
      (ts.isPrefixUnaryExpression(node) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)) ||
      (ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
    ) {
      hasPotentialSideEffect = true
      return
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(execute.body, visit)
  if (!hasPotentialSideEffect) return "read"

  return "unknown"
}

function detectValidation(
  execute: ts.ArrowFunction | ts.FunctionExpression,
  sourceFile: ts.SourceFile
): "present" | "absent" | "unknown" {
  if (!execute.body) return "unknown"
  const bodyText = getTextOf(execute.body, sourceFile)
  if (
    /\btypeof\s+\w+\s*(?:===?|!==?)\s*["']/.test(bodyText) ||
    /\bis[A-Z]\w+\s*\(/.test(bodyText)
  ) {
    return "present"
  }
  if (/\b(?:parse|safeParse|parseSafe|validate)\s*\(/.test(bodyText)) return "unknown"
  if (/\b(input|params|args)\b/.test(bodyText)) return "absent"
  const input = execute.parameters[0]
  if (
    input &&
    ((ts.isObjectBindingPattern(input.name) && input.name.elements.length > 0) ||
      ts.isIdentifier(input.name))
  ) {
    return "absent"
  }
  return "unknown"
}

function findRegistrationCleanup(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile
): boolean | null {
  let current: ts.Node = call
  while (current) {
    if (
      ts.isCallExpression(current) &&
      ((ts.isIdentifier(current.expression) && current.expression.text === "useEffect") ||
        (ts.isPropertyAccessExpression(current.expression) &&
          current.expression.name.text === "useEffect"))
    ) {
      const bodyText = getTextOf(current, sourceFile)
      return (
        /\breturn\s*\(\)\s*=>/.test(bodyText) && /\b(unregister|cleanup|abort)\b/.test(bodyText)
      )
    }
    if (
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isFunctionDeclaration(current)
    ) {
      const bodyText = getTextOf(current, sourceFile)
      if (/\breturn\s*\(\)\s*=>\s*\{?\s*\b(unregister|cleanup|abort)\b/.test(bodyText)) {
        return true
      }
      if (/\bnew\s+AbortController\b/.test(bodyText) && /\breturn\s*\(\)/.test(bodyText)) {
        return true
      }
    }
    if (current.kind === ts.SyntaxKind.SourceFile) return true
    current = current.parent
  }
  return null
}

export async function discoverImperativeTools(
  file: WebMcpScanFile,
  lineOffset: number,
  signal?: AbortSignal,
  maxDefinitions = Number.POSITIVE_INFINITY
): Promise<ImperativeDiscoveryResult> {
  if (file.truncated || !file.content) {
    return { tools: [], incomplete: 0, limitReached: false, specDriftFindings: [] }
  }

  const sourceFile = ts.createSourceFile(
    file.path,
    file.content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(file)
  )

  const tools: WebMcpToolSurface[] = []
  let incomplete = 0
  let limitReached = false
  const specDriftFindings: WebMcpSpecDriftFinding[] = []

  const recordSpecDrift = (ruleId: string, node: ts.Node): void => {
    const startLine = getLineNumber(file.content, node.getStart(sourceFile)) + lineOffset
    const endLine = getLineNumber(file.content, node.getEnd()) + lineOffset
    const finding = { ruleId, path: file.path, startLine, endLine }
    if (
      !specDriftFindings.some(
        (existing) =>
          existing.ruleId === finding.ruleId &&
          existing.path === finding.path &&
          existing.startLine === finding.startLine &&
          existing.endLine === finding.endLine
      )
    ) {
      specDriftFindings.push(finding)
    }
  }

  function visit(node: ts.Node) {
    if (signal?.aborted || limitReached) return
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "navigator" &&
      node.name.text === "modelContext"
    ) {
      recordSpecDrift("WEBMCP-13.legacy-navigator-model-context", node)
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["provideContext", "clearContext", "unregisterTool", "requestUserInteraction"].includes(
        node.expression.name.text
      )
    ) {
      recordSpecDrift("WEBMCP-13.removed-api", node)
    }
    const registration = classifyRegisterToolCall(node)
    if (!registration) {
      ts.forEachChild(node, visit)
      return
    }
    if (registration === "ambiguous") {
      incomplete++
      ts.forEachChild(node, visit)
      return
    }
    if (tools.length >= maxDefinitions) {
      limitReached = true
      return
    }

    const call = node as ts.CallExpression
    const arg = call.arguments[0]
    if (!arg || !ts.isObjectLiteralExpression(arg)) {
      incomplete++
      ts.forEachChild(node, visit)
      return
    }

    const name = getPropertyString(arg, "name", sourceFile)
    const title = getPropertyString(arg, "title", sourceFile) ?? name
    const description = getPropertyString(arg, "description", sourceFile)

    const annotationsObj = getPropertyValue(arg, "annotations", sourceFile)
    const readOnlyHint =
      annotationsObj && ts.isObjectLiteralExpression(annotationsObj)
        ? getPropertyBoolean(annotationsObj, "readOnlyHint", sourceFile)
        : null
    const untrustedContentHint =
      annotationsObj && ts.isObjectLiteralExpression(annotationsObj)
        ? getPropertyBoolean(annotationsObj, "untrustedContentHint", sourceFile)
        : null

    if (annotationsObj && ts.isObjectLiteralExpression(annotationsObj)) {
      for (const property of annotationsObj.properties) {
        if (!ts.isPropertyAssignment(property)) continue
        const annotation = ts.isIdentifier(property.name)
          ? property.name.text
          : ts.isStringLiteral(property.name)
            ? property.name.text
            : null
        if (annotation && annotation !== "readOnlyHint" && annotation !== "untrustedContentHint") {
          recordSpecDrift("WEBMCP-13.unsupported-annotation", property)
        }
      }
    }

    for (const option of ["exposedTo", "signal"]) {
      const misplaced = getPropertyValue(arg, option, sourceFile)
      if (misplaced) recordSpecDrift("WEBMCP-13.misplaced-registration-option", misplaced)
    }

    const registrationOptions = call.arguments[1]
    const exposedToNode =
      registrationOptions && ts.isObjectLiteralExpression(registrationOptions)
        ? getPropertyValue(registrationOptions, "exposedTo", sourceFile)
        : getPropertyValue(arg, "exposedTo", sourceFile)
    const exposedTo = extractExposedTo(exposedToNode, sourceFile)
    const inputSchema = extractInputSchema(
      getPropertyValue(arg, "inputSchema", sourceFile),
      sourceFile
    )
    const execute = findExecute(arg, sourceFile)

    let behavior: "read" | "ui-only" | "mutation" | "unknown" = "unknown"
    let networkMethods: string[] = []
    let returnsExternalContent: boolean | null = null
    let forwardsCancellation: boolean | null = null
    let runtimeValidation: "present" | "absent" | "unknown" = "unknown"

    if (execute) {
      const network = analyzeNetworkCalls(execute, sourceFile)
      networkMethods = network.methods
      returnsExternalContent = network.returnsExternal
      forwardsCancellation = network.forwardsCancellation
      behavior = detectBehavior(execute, sourceFile, network)
      runtimeValidation = detectValidation(execute, sourceFile)
    } else {
      incomplete++
    }

    const registrationSignal =
      registrationOptions && ts.isObjectLiteralExpression(registrationOptions)
        ? getPropertyValue(registrationOptions, "signal", sourceFile)
        : undefined
    const hasRegistrationCleanup = registrationSignal
      ? true
      : findRegistrationCleanup(call, sourceFile)

    const startLine = getLineNumber(file.content, call.getStart(sourceFile)) + lineOffset
    const endLine = getLineNumber(file.content, call.getEnd()) + lineOffset

    const surface: WebMcpToolSurface = {
      kind: "imperative",
      name,
      title,
      description,
      inputSchema,
      annotations: {
        readOnlyHint,
        untrustedContentHint,
      },
      exposedTo,
      behavior,
      networkMethods,
      returnsExternalContent,
      forwardsCancellation,
      hasRegistrationCleanup,
      runtimeValidation,
      source: { path: file.path, startLine, endLine },
      definitionHash: "",
    }

    tools.push(surface)

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  if (signal?.aborted) throw new Error("WebMCP discovery cancelled")

  for (const tool of tools) {
    tool.definitionHash = await computeDefinitionHash(tool, sha256)
  }

  return { tools, incomplete, limitReached, specDriftFindings }
}
