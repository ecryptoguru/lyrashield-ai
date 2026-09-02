import type { WebMcpEvidenceState, WebMcpScanFile } from "../types"

export interface WebMcpFixture {
  name: string
  description: string
  file: WebMcpScanFile
  expectedStates?: Record<string, WebMcpEvidenceState>
  expectedDefinitionCount?: number
  expectedIncomplete?: number
  expectedHasToolIframe?: boolean
  expectedHeaderExposure?: Record<string, boolean | null>
}

const tsFile = (
  path: string,
  content: string,
  extra?: Partial<WebMcpScanFile>
): WebMcpScanFile => ({
  path,
  content,
  size: content.length,
  extension: ".ts",
  language: "typescript",
  ...extra,
})

const astroFile = (
  path: string,
  content: string,
  extra?: Partial<WebMcpScanFile>
): WebMcpScanFile => ({
  path,
  content,
  size: content.length,
  extension: ".astro",
  language: "astro",
  ...extra,
})

const htmlFile = (
  path: string,
  content: string,
  extra?: Partial<WebMcpScanFile>
): WebMcpScanFile => ({
  path,
  content,
  size: content.length,
  extension: ".html",
  language: "html",
  ...extra,
})

const configFile = (
  path: string,
  content: string,
  extra?: Partial<WebMcpScanFile>
): WebMcpScanFile => ({
  path,
  content,
  size: content.length,
  extension: path.slice(path.lastIndexOf(".")),
  language: "config",
  ...extra,
})

const SAFE_IMPERATIVE = `
import { z } from "zod"

const schema = z.object({
  query: z.string().max(200),
})

document.modelContext.registerTool({
  name: "search_docs",
  title: "Search documentation",
  description: "Search the documentation index.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        maxLength: 200,
        description: "Search query",
      },
    },
    required: ["query"],
  },
  annotations: {
    readOnlyHint: true,
    untrustedContentHint: true,
  },
  execute: async ({ query }, { signal }) => {
    if (typeof query !== "string") throw new Error("Invalid query")
    schema.parse({ query })
    const response = await fetch(\`/api/docs?query=\${encodeURIComponent(query)}\`, { signal })
    return response.json()
  },
}, { exposedTo: [] })
`

const UNSAFE_IMPERATIVE = `
import { useEffect } from "react"

function Dashboard() {
  useEffect(() => {
    document.modelContext.registerTool({
      name: "delete_user",
      title: "Delete user",
      description: "Permanently delete a user account.",
      inputSchema: {
        type: "object",
      },
      execute: async ({ userId }) => {
        await fetch("/api/users/" + userId, { method: "DELETE" })
      },
    }, { exposedTo: ["*"] })
  }, [])
}
`

const SAFE_DECLARATIVE = `
<!DOCTYPE html>
<html>
<body>
  <form toolname="search_cars" tooldescription="Search car listings" method="get" action="/cars">
    <label for="make">Make</label>
    <input type="text" name="make" id="make" maxlength="50" required toolparamdescription="Vehicle make (e.g. Ford)">
    <button type="submit">Search</button>
  </form>
</body>
</html>
`

const UNSAFE_DECLARATIVE = `
<!DOCTYPE html>
<html>
<body>
  <form toolname="delete_account" tooldescription="Delete the account" method="post" toolautosubmit>
    <input type="text" name="accountId">
    <button type="submit">Delete</button>
  </form>
</body>
</html>
`

const ASTRO_FILE = `---
const title = "Lab"
---

<script>
  document.modelContext.registerTool({
    name: "submit_feedback",
    title: "Submit feedback",
    description: "Send anonymous feedback.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        message: { type: "string", maxLength: 500, description: "Feedback message" },
      },
      required: ["message"],
    },
    annotations: { readOnlyHint: false },
    execute: async ({ message }, { signal }) => {
      await fetch("/api/feedback", { method: "POST", body: JSON.stringify({ message }), signal })
    },
  })
</script>

<form toolname="search_articles" tooldescription="Search help articles" method="get">
  <input type="text" name="query" maxlength="100" required toolparamdescription="Search query">
  <button type="submit">Search</button>
</form>
`

const DYNAMIC_NAME_SCHEMA = `
const myTool = buildTool()

modelContext.registerTool(myTool, { exposedTo: someOrigin() })
`

const MALFORMED_SOURCE = `
document.modelContext.registerTool({
  name: "broken"
  inputSchema: missing
  execute:
`

const DUPLICATE_NAMES = `
document.modelContext.registerTool({
  name: "same_name",
  description: "First.",
  execute: () => ({ ok: true }),
})

document.modelContext.registerTool({
  name: "same_name",
  description: "Second.",
  execute: () => ({ ok: true }),
})
`

const PROTECTIVE_WORDING =
  `
document.modelContext.registerTool({
  name: "unsafe_example",
  title: "Do not use: unsafe example of a destructive tool",
  description: "This is an anti-pattern. Never call this in production.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      userId: { type: "string", maxLength: 64, description: "User identifier" },
    },
    required: ["userId"],
  },
  execute: ({ userId }) => ({ example: ` +
  "`Never delete ${userId} without confirmation.`" +
  ` }),
})
`

const HEADER_SELF = `/*
  Origin-Agent-Cluster: ?1
  Permissions-Policy: tools=(self)
*/
`

const HEADER_WILDCARD = `/*
  Origin-Agent-Cluster: ?1
  Permissions-Policy: tools=(*)
*/
`

const HEADER_OAC_DISABLED = `/*
  Origin-Agent-Cluster: ?0
  Permissions-Policy: tools=(self)
*/
`

const DELEGATED_IFRAME = `
<!DOCTYPE html>
<html>
<body>
  <iframe src="https://example.com" allow="tools 'self' https://example.com"></iframe>
</body>
</html>
`

const CANCELLATION_ABORT = `
document.modelContext.registerTool({
  name: "slow_query",
  description: "Run a slow query.",
  execute: async (_, { signal }) => {
    return await fetch("/api/slow", { signal })
  },
})
`

const LIMITS_MANY_FILES = Array.from({ length: 10 }, (_, i) =>
  tsFile(
    `src/tool-${i}.ts`,
    `
document.modelContext.registerTool({
  name: "tool_${i}",
  description: "Tool ${i}.",
  execute: () => ({ ok: true }),
})
`
  )
)

export const WEBMCP_FIXTURES: WebMcpFixture[] = [
  {
    name: "safe imperative",
    description:
      "A read-only, bounded, validated, cancellable tool with cleanup implicit at module scope.",
    file: tsFile("src/safe-imperative.ts", SAFE_IMPERATIVE),
    expectedStates: {
      "WEBMCP-01": "NO_FINDING",
      "WEBMCP-02": "NO_FINDING",
      "WEBMCP-03": "NO_FINDING",
      "WEBMCP-05": "NO_FINDING",
      "WEBMCP-06": "NO_FINDING",
      "WEBMCP-07": "NO_FINDING",
      "WEBMCP-09": "NO_FINDING",
    },
    expectedDefinitionCount: 1,
    expectedIncomplete: 0,
  },
  {
    name: "unsafe imperative",
    description:
      "A destructive tool inside an effect with no cleanup, no cancellation, wildcard exposure, and no validation.",
    file: tsFile("src/unsafe-imperative.tsx", UNSAFE_IMPERATIVE),
    expectedStates: {
      "WEBMCP-03": "DETECTED",
      "WEBMCP-05": "DETECTED",
      "WEBMCP-07": "DETECTED",
      "WEBMCP-08": "DETECTED",
      "WEBMCP-09": "DETECTED",
    },
    expectedDefinitionCount: 1,
    expectedIncomplete: 0,
  },
  {
    name: "safe declarative",
    description: "A GET form with bounded, required, described parameters.",
    file: htmlFile("src/safe-declarative.html", SAFE_DECLARATIVE),
    expectedDefinitionCount: 1,
    expectedIncomplete: 0,
  },
  {
    name: "unsafe declarative",
    description: "A POST form with autosubmit, no validation, and an unbounded parameter.",
    file: htmlFile("src/unsafe-declarative.html", UNSAFE_DECLARATIVE),
    expectedStates: {
      "WEBMCP-05": "DETECTED",
      "WEBMCP-06": "DETECTED",
      "WEBMCP-09": "DETECTED",
    },
    expectedDefinitionCount: 1,
    expectedIncomplete: 0,
  },
  {
    name: "astro file",
    description:
      "An Astro file with a frontmatter variable, an imperative script tool, and a declarative form.",
    file: astroFile("src/lab.astro", ASTRO_FILE),
    expectedDefinitionCount: 2,
    expectedIncomplete: 0,
  },
  {
    name: "dynamic name and schema",
    description:
      "A registration where the tool object and exposedTo origin are not statically resolvable.",
    file: tsFile("src/dynamic.ts", DYNAMIC_NAME_SCHEMA),
    expectedDefinitionCount: 0,
    expectedIncomplete: 1,
  },
  {
    name: "malformed source",
    description: "A TypeScript file with unclosed braces that the parser cannot fully resolve.",
    file: tsFile("src/malformed.ts", MALFORMED_SOURCE),
    expectedDefinitionCount: 0,
    expectedIncomplete: 1,
  },
  {
    name: "duplicate names",
    description: "Two imperative tools registered with the same name.",
    file: tsFile("src/duplicates.ts", DUPLICATE_NAMES),
    expectedStates: {
      "WEBMCP-10": "DETECTED",
    },
    expectedDefinitionCount: 2,
    expectedIncomplete: 0,
  },
  {
    name: "protective wording",
    description:
      "An educational tool whose output mentions a destructive anti-pattern without performing it.",
    file: tsFile("src/protective.ts", PROTECTIVE_WORDING),
    expectedStates: {
      "WEBMCP-05": "NO_FINDING",
    },
    expectedDefinitionCount: 1,
    expectedIncomplete: 0,
  },
  {
    name: "header self policy",
    description: "A config file with safe self-scoped Permissions-Policy.",
    file: configFile("_headers", HEADER_SELF),
    expectedDefinitionCount: 0,
    expectedIncomplete: 0,
    expectedHeaderExposure: {
      hasOriginAgentCluster: true,
      hasToolsSelfPolicy: true,
      hasWildcardToolsPolicy: false,
    },
  },
  {
    name: "header wildcard policy",
    description: "A config file with a wildcard Permissions-Policy.",
    file: configFile("_headers", HEADER_WILDCARD),
    expectedDefinitionCount: 0,
    expectedIncomplete: 0,
    expectedHeaderExposure: {
      hasOriginAgentCluster: true,
      hasToolsSelfPolicy: false,
      hasWildcardToolsPolicy: true,
    },
  },
  {
    name: "header disabled origin agent cluster",
    description: "A config file with Origin-Agent-Cluster: ?0.",
    file: configFile("_headers", HEADER_OAC_DISABLED),
    expectedDefinitionCount: 0,
    expectedIncomplete: 0,
    expectedHeaderExposure: {
      hasOriginAgentCluster: false,
      hasToolsSelfPolicy: true,
    },
  },
  {
    name: "delegated tools iframe",
    description: "An HTML page with a cross-origin iframe exposing tools.",
    file: htmlFile("src/delegated.html", DELEGATED_IFRAME),
    expectedDefinitionCount: 0,
    expectedHasToolIframe: true,
    expectedIncomplete: 0,
  },
  {
    name: "cancellation support",
    description: "A tool that forwards the AbortSignal into fetch.",
    file: tsFile("src/cancellation.ts", CANCELLATION_ABORT),
    expectedStates: {
      "WEBMCP-07": "NO_FINDING",
    },
    expectedDefinitionCount: 1,
    expectedIncomplete: 0,
  },
  {
    name: "limits many files",
    description: "A list of small files used to test maxFiles and maxDefinitions limits.",
    file: tsFile("__many_files__.ts", ""),
    expectedDefinitionCount: 0,
    expectedIncomplete: 0,
  },
]

export const MANY_FILES = LIMITS_MANY_FILES
