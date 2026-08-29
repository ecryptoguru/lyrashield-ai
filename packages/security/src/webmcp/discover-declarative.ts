import { parse } from "parse5"
import { computeDefinitionHash } from "./canonicalize"
import { sha256 } from "./hash"
import { getLineNumber } from "./utils"
import type {
  DeclarativeDiscoveryResult,
  WebMcpScanFile,
  WebMcpScanLimit,
  WebMcpSchemaProperty,
  WebMcpToolSurface,
} from "./types"
import type { DefaultTreeAdapterTypes } from "parse5"

type Element = DefaultTreeAdapterTypes.Element
type Node = DefaultTreeAdapterTypes.Node

interface AttrMap {
  [key: string]: string | undefined
}

function getAttr(attrs: AttrMap, name: string): string | undefined {
  return attrs[name]
}

function attrsToMap(node: Element): AttrMap {
  const map: AttrMap = {}
  for (const attr of node.attrs) {
    map[attr.name] = attr.value
  }
  return map
}

interface DiscoveredForm {
  element: Element
  properties: WebMcpSchemaProperty[]
  required: string[]
}

function scanDocument(
  root: Node,
  signal: AbortSignal | undefined,
  limits: { maxWalkEntries: number; maxWalkDepth: number }
): {
  forms: DiscoveredForm[]
  hasToolIframe: boolean
  limitsReached: WebMcpScanLimit[]
} {
  const forms: DiscoveredForm[] = []
  const limitsReached = new Set<WebMcpScanLimit>()
  const stack: { node: Node; depth: number; form?: DiscoveredForm }[] = [{ node: root, depth: 0 }]
  let entries = 0
  let hasToolIframe = false

  while (stack.length > 0) {
    if (signal?.aborted) throw new Error("WebMCP discovery cancelled")
    if (entries >= limits.maxWalkEntries) {
      limitsReached.add("max_walk_entries")
      break
    }
    const current = stack.pop()!
    if (current.depth > limits.maxWalkDepth) {
      limitsReached.add("max_walk_depth")
      continue
    }
    entries++

    const node = current.node
    let activeForm = current.form
    if ("nodeName" in node && node.nodeName === "form") {
      const element = node as Element
      if (getAttr(attrsToMap(element), "toolname")) {
        activeForm = { element, properties: [], required: [] }
        forms.push(activeForm)
      }
    }

    if ("nodeName" in node && node.nodeName === "iframe") {
      const allow = getAttr(attrsToMap(node as Element), "allow") ?? ""
      if (/\btools\b/.test(allow)) hasToolIframe = true
    }

    if (
      activeForm &&
      "nodeName" in node &&
      ["input", "textarea", "select"].includes(node.nodeName)
    ) {
      const attrs = attrsToMap(node as Element)
      const name = getAttr(attrs, "name")
      if (name) {
        const type =
          node.nodeName === "textarea"
            ? "string"
            : getAttr(attrs, "type") === "number"
              ? "number"
              : "string"
        const isRequired = getAttr(attrs, "required") !== undefined
        activeForm.properties.push({
          name,
          type,
          required: isRequired,
          description: getAttr(attrs, "toolparamdescription"),
          bounded:
            getAttr(attrs, "maxlength") !== undefined ||
            getAttr(attrs, "max") !== undefined ||
            (node.nodeName === "select" && getAttr(attrs, "multiple") === undefined),
        })
        if (isRequired) activeForm.required.push(name)
      }
    }

    if ("childNodes" in node && Array.isArray(node.childNodes)) {
      for (let index = node.childNodes.length - 1; index >= 0; index--) {
        stack.push({ node: node.childNodes[index]!, depth: current.depth + 1, form: activeForm })
      }
    }
  }

  return { forms, hasToolIframe, limitsReached: [...limitsReached] }
}

export async function discoverDeclarativeTools(
  file: WebMcpScanFile,
  lineOffset: number,
  signal?: AbortSignal,
  limits: { maxWalkEntries: number; maxWalkDepth: number; maxDefinitions?: number } = {
    maxWalkEntries: 50_000,
    maxWalkDepth: 40,
  }
): Promise<DeclarativeDiscoveryResult> {
  if (file.truncated || !file.content) {
    return { tools: [], incomplete: 0, hasToolIframe: false, limitsReached: [] }
  }

  const document = parse(file.content, { sourceCodeLocationInfo: true })
  const scan = scanDocument(document, signal, limits)
  const tools: WebMcpToolSurface[] = []
  let incomplete = scan.limitsReached.length
  const maxDefinitions = limits.maxDefinitions ?? Number.POSITIVE_INFINITY

  for (const discovered of scan.forms) {
    if (signal?.aborted) throw new Error("WebMCP discovery cancelled")
    if (tools.length >= maxDefinitions) {
      scan.limitsReached.push("max_definitions")
      break
    }

    const form = discovered.element
    const attrs = attrsToMap(form)
    const name = getAttr(attrs, "toolname")
    if (!name) {
      incomplete++
      continue
    }

    const title = getAttr(attrs, "tooltitle") ?? name
    const description = getAttr(attrs, "tooldescription") ?? null
    const autoSubmit = getAttr(attrs, "toolautosubmit") !== undefined
    const method = (getAttr(attrs, "method") ?? "get").toUpperCase()
    const exposedToRaw = getAttr(attrs, "toolexposedto")

    const exposedTo: string[] | "dynamic" | null = (() => {
      if (!exposedToRaw) return null
      const values = exposedToRaw.split(/[,\s]+/).filter(Boolean)
      if (values.includes("*")) return values
      return values
    })()

    const inputSchema = {
      type: "object" as const,
      properties: discovered.properties,
      additionalProperties: false as const,
      required: discovered.required,
    }

    const location = form.sourceCodeLocation
    const startPos = location?.startTag?.startOffset ?? 0
    const endPos = location?.endTag?.endOffset ?? location?.startTag?.endOffset ?? startPos

    const surface: WebMcpToolSurface = {
      kind: "declarative",
      name,
      title,
      description,
      inputSchema,
      annotations: {
        readOnlyHint: method === "GET" ? true : false,
        untrustedContentHint: false,
      },
      exposedTo,
      behavior: autoSubmit ? "mutation" : method === "GET" ? "read" : "ui-only",
      networkMethods: [method],
      returnsExternalContent: false,
      forwardsCancellation: null,
      hasRegistrationCleanup: true,
      runtimeValidation:
        discovered.properties.length === 0
          ? "unknown"
          : discovered.properties.some((p) => p.required || p.bounded)
            ? "present"
            : "absent",
      source: {
        path: file.path,
        startLine: getLineNumber(file.content, startPos) + lineOffset,
        endLine: getLineNumber(file.content, endPos) + lineOffset,
      },
      definitionHash: "",
    }

    tools.push(surface)
  }

  if (signal?.aborted) throw new Error("WebMCP discovery cancelled")

  for (const tool of tools) {
    tool.definitionHash = await computeDefinitionHash(tool, sha256)
  }

  return {
    tools,
    incomplete,
    hasToolIframe: scan.hasToolIframe,
    limitsReached: scan.limitsReached,
  }
}
