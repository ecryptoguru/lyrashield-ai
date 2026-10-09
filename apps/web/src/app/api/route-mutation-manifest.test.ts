import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import * as ts from "typescript"
import { describe, expect, it } from "vitest"

const API_ROOT = path.dirname(fileURLToPath(import.meta.url))
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

type BoundaryGroup = {
  description: string
  marker?: string
  additionalMarkers?: readonly string[]
  routes: readonly string[]
}

/**
 * Each mutation is classified by its actual trust boundary. Route keys are
 * relative to apps/web/src/app/api and end in #METHOD. Versioned re-exports
 * are listed separately and inherit the canonical route's boundary.
 */
const BOUNDARY_GROUPS = {
  delegatedTargetScope: {
    description:
      "The workspace permission is delegable, so the handler checks the actual persisted or validated target before mutation.",
    marker: "assertOAuthDelegatedScope",
    additionalMarkers: ["requirePermission"],
    routes: [
      "reports/[id]#POST",
      "reports/launch-readiness#POST",
      "reports#POST",
      "scans/[id]#POST",
      "scans/[id]#DELETE",
      "scans/attachments/[id]#DELETE",
      "scans/attachments#POST",
      "scans#POST",
      "findings/[id]/fix-proposals#POST",
      "findings/[id]/retests#POST",
      "fix-proposals/[id]/create-pr#POST",
      "gate/[targetId]#POST",
    ],
  },
  workspacePermission: {
    description:
      "The handler checks active workspace membership and its declared permission. No delegated target scope applies unless the handler is listed in delegatedTargetScope.",
    marker: "requirePermission",
    routes: [
      "agent-approvals/[id]/approve#POST",
      "agent-approvals/[id]/deny#POST",
      "agent-approvals#POST",
      "ai-assurance/evidence/[id]/artifacts#POST",
      "ai-assurance/evidence/[id]/review#POST",
      "ai-assurance/evidence/[id]/revise#POST",
      "ai-assurance/evidence/not-applicable#POST",
      "ai-assurance/evidence#POST",
      "ai-assurance/profile#POST",
      "ai-assurance/threat-model#POST",
      "billing/spend-limit#POST",
      "billing/topup#POST",
      "billing/trial/start#POST",
      "findings/[id]#PATCH",
      "integrations/connectors/[id]/disable#POST",
      "integrations/github/install#POST",
      "integrations/slack/install#POST",
      "live-ai-safety#PUT",
      "live-ai-safety#POST",
      "notifications/[id]#PATCH",
      "notifications#POST",
      "notifications#PATCH",
      "projects#POST",
      "schedules/[id]#PATCH",
      "schedules/[id]#DELETE",
      "schedules#POST",
      "scorecards/[id]#DELETE",
      "sync/connect#POST",
      "sync/cursor#PUT",
      "sync/findings#POST",
      "target-domain-verifications#POST",
      "target-domain-verifications#PUT",
      "targets/[id]#PATCH",
      "targets/[id]#DELETE",
      "targets/[id]/scorecard#POST",
      "targets#POST",
      "team/invitations/[id]#DELETE",
      "team#POST",
    ],
  },
  workspacePermissionOauthDenied: {
    description:
      "SARIF import checks workspace permission then explicitly denies hosted OAuth sessions; scan creation does not grant arbitrary import authority.",
    marker: "session.oauth",
    additionalMarkers: ["requirePermission"],
    routes: ["scans/[id]/artifacts/sarif#POST"],
  },
  browserSessionOnly: {
    description:
      "The operation is restricted to a browser session and the authenticated user's own workspace or membership.",
    marker: "assertBrowserSession",
    routes: [
      "api-keys/[id]#DELETE",
      "api-keys#POST",
      "team/invitations/accept#POST",
      "workspaces/active#POST",
    ],
  },
  browserWorkspaceNotificationSettings: {
    description:
      "Notification webhooks require a browser session and workspace integration management; credential and hosted OAuth mutations are denied.",
    marker: "session.apiKey",
    additionalMarkers: ["session.oauth", "requirePermission"],
    routes: [
      "integrations/notifications#POST",
      "integrations/notifications#DELETE",
      "integrations/notifications/test#POST",
    ],
  },
  accountSession: {
    description:
      "The handler uses the signed-in user's session to change account-owned state or create the user's workspace.",
    marker: "getSession",
    routes: [
      "account/preferences#PATCH",
      "account#DELETE",
      "notifications/preferences#PATCH",
      "onboarding#PATCH",
      "referrals/claim#POST",
      "workspaces#POST",
    ],
  },
  memberGovernanceHelper: {
    description:
      "The shared changeMember operation applies the workspace membership and role policy to the selected member.",
    marker: "changeMember",
    routes: ["team#PATCH", "team#DELETE"],
  },
  browserOAuthConnection: {
    description:
      "The browser connection-manager helper binds the OAuth connection to its owner; connection creation also validates consent state.",
    marker: "requireBrowserConnectionManager",
    routes: [
      "connections/[id]/pause#POST",
      "connections/[id]/resume#POST",
      "connections/[id]/revoke#POST",
      "connections/[id]#DELETE",
      "connections#POST",
    ],
  },
  platformAdministrator: {
    description:
      "The operation requires the platform-admin allowlist and role; sensitive administration also checks recent TOTP elevation.",
    marker: "requirePlatformAdmin",
    routes: [
      "admin/affiliates/action#POST",
      "admin/elevations#POST",
      "admin/webhook-tracks/[id]/retry#POST",
      "admin/webhook-tracks/[id]/disposition#POST",
      "licenses/revoke#POST",
      "myra/operator/cases/[id]#PATCH",
      "myra/operator/cases/[id]/replies#POST",
    ],
  },
  internalServiceKey: {
    description:
      "License issuance and renewal accept only the internal service credential, not a tenant or browser session.",
    marker: "requireInternalApiKey",
    routes: ["licenses/issue#POST", "licenses/renew#POST"],
  },
  verifiedProviderWebhook: {
    description:
      "The provider event is admitted only after GitHub's webhook signature is verified.",
    marker: "verifyWebhookSignature",
    routes: ["webhooks/github#POST"],
  },
  authenticationProtocol: {
    description:
      "The Better Auth protocol handler validates its own authentication and OAuth protocol requests.",
    marker: "handlers.POST",
    routes: ["auth/[...all]#POST"],
  },
  mcpToolAuthorization: {
    description:
      "The MCP route authenticates the request and applies authorization at the individual tool boundary.",
    marker: "authenticate",
    routes: ["mcp#POST", "mcp#DELETE"],
  },
  myraPublicSession: {
    description:
      "The public Myra surface uses a public-session credential, feature admission, per-IP rate limits, and Turnstile where a credential is issued.",
    marker: "checkMyraRateLimit",
    routes: [
      "myra/cases/[id]/replies#POST",
      "myra/demo/manage/[token]#POST",
      "myra/demo/slots#POST",
      "myra/feedback#POST",
      "myra/identity/confirm#POST",
      "myra/identity/request#POST",
      "myra/message#POST",
      "myra/proposals/cancel#POST",
      "myra/proposals/confirm#POST",
      "myra/session#POST",
      "myra/suggest#POST",
    ],
  },
  myraAccountSession: {
    description:
      "Memory deletion requires a resolved user principal and is limited to that account's memory.",
    marker: "resolveMyraRequest",
    routes: ["myra/memory#DELETE"],
  },
  localCheckoutAdmission: {
    description:
      "The public checkout is controlled by local-billing admission and per-IP checkout rate limiting.",
    marker: "localBillingAdmissionError",
    routes: ["billing/local-checkout#POST"],
  },
  publicLicenseKey: {
    description:
      "License activation requires possession of a valid key and is rate-limited by the public license API boundary.",
    marker: "checkLicenseApiRateLimit",
    routes: ["licenses/activate#POST"],
  },
  publicLicenseRetrievalToken: {
    description: "License retrieval is authorized by the server-issued retrieval token.",
    marker: "retrieveLicenseByToken",
    routes: ["licenses/retrieve#POST"],
  },
  publicLicenseSignature: {
    description: "License verification validates the signed license artifact and is rate-limited.",
    marker: "verifyLicense",
    routes: ["licenses/verify#POST"],
  },
  publicTurnstileProof: {
    description:
      "The public scan and scorecard submissions require Turnstile proof and their corresponding abuse controls.",
    marker: "verifyTurnstile",
    routes: ["lite-scan#POST", "lite-scorecards#POST"],
  },
  sameOriginReferralCookie: {
    description:
      "Referral capture is a same-origin public operation that validates a referral code and writes only attribution cookies.",
    marker: "assertSameOriginMutation",
    routes: ["referrals/capture#POST"],
  },
  publicReportSignature: {
    description:
      "Report verification is a public, rate-limited verification of a signed report artifact; it does not change workspace state.",
    marker: "verifyLaunchReportSignature",
    routes: ["reports/verify#POST"],
  },
  publicScorecardAnalytics: {
    description:
      "The public event endpoint accepts only public scorecard identifiers and uses a server-signed visitor cookie for deduplication.",
    marker: "verifyVisitorToken",
    routes: ["scorecards/events#POST"],
  },
  publicAnalyticsOptOut: {
    description:
      "The public opt-out endpoint validates the allowed origin and only clears optional tracking cookies.",
    marker: "isPublicOriginAllowed",
    routes: ["privacy/analytics-opt-out#POST"],
  },
} satisfies Record<string, BoundaryGroup>

/** Re-exports are explicit and must continue pointing to the classified route. */
const VERSIONED_ROUTE_ALIASES: Record<string, string> = {
  "v1/agent-approvals/[id]/approve#POST": "agent-approvals/[id]/approve#POST",
  "v1/agent-approvals/[id]/deny#POST": "agent-approvals/[id]/deny#POST",
  "v1/agent-approvals#POST": "agent-approvals#POST",
  "v1/findings/[id]/fix-proposals#POST": "findings/[id]/fix-proposals#POST",
  "v1/findings/[id]/retests#POST": "findings/[id]/retests#POST",
  "v1/findings/[id]#PATCH": "findings/[id]#PATCH",
  "v1/fix-proposals/[id]/create-pr#POST": "fix-proposals/[id]/create-pr#POST",
  "v1/gate/[targetId]#POST": "gate/[targetId]#POST",
  "v1/projects#POST": "projects#POST",
  "v1/reports/[id]#POST": "reports/[id]#POST",
  "v1/reports#POST": "reports#POST",
  "v1/scans/[id]/artifacts/sarif#POST": "scans/[id]/artifacts/sarif#POST",
  "v1/scans/[id]#POST": "scans/[id]#POST",
  "v1/scans/attachments/[id]#DELETE": "scans/attachments/[id]#DELETE",
  "v1/scans/attachments#POST": "scans/attachments#POST",
  "v1/scans#POST": "scans#POST",
  "v1/schedules/[id]#DELETE": "schedules/[id]#DELETE",
  "v1/schedules/[id]#PATCH": "schedules/[id]#PATCH",
  "v1/schedules#POST": "schedules#POST",
  "v1/target-domain-verifications#POST": "target-domain-verifications#POST",
  "v1/target-domain-verifications#PUT": "target-domain-verifications#PUT",
  "v1/targets/[id]#DELETE": "targets/[id]#DELETE",
  "v1/targets/[id]#PATCH": "targets/[id]#PATCH",
  "v1/targets#POST": "targets#POST",
  "v1/workspaces#POST": "workspaces#POST",
}

const EXPECTED_DELEGATED_SCOPE_CALLS: Record<string, string> = {
  "reports/[id]#POST": "assertOAuthDelegatedScope(session,delegation.targetId)",
  "reports/launch-readiness#POST": "assertOAuthDelegatedScope(session,targetId)",
  "reports#POST": "assertOAuthDelegatedScope(session,targetId)",
  "scans/[id]#POST": "assertOAuthDelegatedScope(session,scan.targetId)",
  "scans/[id]#DELETE": "assertOAuthDelegatedScope(session,scan.targetId)",
  "scans/attachments/[id]#DELETE": "assertOAuthDelegatedScope(session,null)",
  "scans/attachments#POST": "assertOAuthDelegatedScope(session,null)",
  "scans#POST": "assertOAuthDelegatedScope(session,data.targetId,data.mode)",
  "findings/[id]/fix-proposals#POST": "assertOAuthDelegatedScope(session,finding.targetId)",
  "findings/[id]/retests#POST": "assertOAuthDelegatedScope(session,finding.targetId)",
  "fix-proposals/[id]/create-pr#POST": "assertOAuthDelegatedScope(session,context.targetId)",
  "gate/[targetId]#POST": "assertOAuthDelegatedScope(session,targetId)",
}

/** High-risk administrative mutations must retain their explicit elevation boundary. */
const EXPECTED_ELEVATED_PLATFORM_ADMIN_MUTATIONS = {
  "admin/webhook-tracks/[id]/disposition#POST": {
    requestBoundary: "validatePlatformAdminActionRequest(request,{requireElevationNonce:true})",
    forwardedNonce: "nonce:boundary.elevationNonce",
    mutation: "disposeWebhookTrack({",
  },
} as const

type ExportedMutation = {
  key: string
  method: string
  filePath: string
  source: ts.SourceFile
  node: ts.Node
  reexportTarget?: string
}

function walkRouteFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return walkRouteFiles(entryPath)
    if (!entry.isFile()) return []
    if (entry.name === "route.ts" || entry.name === "route.js") return [entryPath]
    if (/^route\.[^.]+$/.test(entry.name)) {
      throw new Error(`unsupported App Router route file: ${entryPath}`)
    }
    return []
  })
}

function routeName(filePath: string): string {
  return path.relative(API_ROOT, filePath).replace(/\/route\.(?:js|ts)$/, "")
}

function mutationExports(): Map<string, ExportedMutation> {
  const handlers = new Map<string, ExportedMutation>()
  for (const filePath of walkRouteFiles(API_ROOT)) {
    const contents = readFileSync(filePath, "utf8")
    const source = ts.createSourceFile(filePath, contents, ts.ScriptTarget.Latest, true)
    for (const statement of source.statements) {
      if (
        ts.isFunctionDeclaration(statement) &&
        statement.name &&
        MUTATION_METHODS.has(statement.name.text) &&
        statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        const key = `${routeName(filePath)}#${statement.name.text}`
        handlers.set(key, {
          key,
          method: statement.name.text,
          filePath,
          source,
          node: statement,
        })
      }
      if (
        ts.isVariableStatement(statement) &&
        statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !MUTATION_METHODS.has(declaration.name.text)) {
            continue
          }
          const key = `${routeName(filePath)}#${declaration.name.text}`
          handlers.set(key, {
            key,
            method: declaration.name.text,
            filePath,
            source,
            node: declaration.initializer ?? declaration,
          })
        }
      }
      if (
        ts.isExportDeclaration(statement) &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        for (const element of statement.exportClause.elements) {
          if (!MUTATION_METHODS.has(element.name.text)) continue
          const key = `${routeName(filePath)}#${element.name.text}`
          let reexportTarget: string | undefined
          if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
            const target = path.resolve(path.dirname(filePath), statement.moduleSpecifier.text)
            const targetFile = statSync(`${target}.ts`, { throwIfNoEntry: false })
              ? `${target}.ts`
              : target
            const targetMethod = element.propertyName?.text ?? element.name.text
            reexportTarget = `${routeName(targetFile)}#${targetMethod}`
          }
          handlers.set(key, {
            key,
            method: element.name.text,
            filePath,
            source,
            node: statement,
            ...(reexportTarget ? { reexportTarget } : {}),
          })
        }
      }
    }
  }
  return handlers
}

function canonicalBoundaries(): Map<string, BoundaryGroup> {
  const boundaries = new Map<string, BoundaryGroup>()
  for (const group of Object.values(BOUNDARY_GROUPS)) {
    for (const key of group.routes) {
      if (boundaries.has(key)) throw new Error(`Duplicate mutation boundary entry: ${key}`)
      boundaries.set(key, group)
    }
  }
  return boundaries
}

function unclassifiedRoutes(routeKeys: Iterable<string>, classifiedKeys: Set<string>): string[] {
  return [...routeKeys].filter((key) => !classifiedKeys.has(key)).sort()
}

function resolveImplementation(
  key: string,
  handlers: Map<string, ExportedMutation>,
  seen = new Set<string>()
): { source: ts.SourceFile; node: ts.Node } {
  const handler = handlers.get(key)
  if (!handler) throw new Error(`Mutation handler missing from inventory: ${key}`)
  if (seen.has(key)) throw new Error(`Mutation handler alias cycle: ${key}`)
  if (handler.reexportTarget) {
    seen.add(key)
    return resolveImplementation(handler.reexportTarget, handlers, seen)
  }

  const declarations = new Map<string, ts.Node>()
  for (const statement of handler.source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      declarations.set(statement.name.text, statement)
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          declarations.set(declaration.name.text, declaration.initializer)
        }
      }
    }
  }

  function unwrap(node: ts.Node, visited = new Set<string>()): ts.Node {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node)
    ) {
      return node
    }
    if (ts.isIdentifier(node)) {
      if (visited.has(node.text)) return node
      visited.add(node.text)
      return unwrap(declarations.get(node.text) ?? node, visited)
    }
    if (ts.isCallExpression(node)) {
      const callable = node.arguments.find(
        (argument) =>
          ts.isIdentifier(argument) ||
          ts.isArrowFunction(argument) ||
          ts.isFunctionExpression(argument)
      )
      if (callable) return unwrap(callable, visited)
    }
    return node
  }

  return { source: handler.source, node: unwrap(handler.node) }
}

function delegatedScopeCalls(node: ts.Node, source: ts.SourceFile): string[] {
  const calls: string[] = []
  function visit(candidate: ts.Node) {
    if (ts.isCallExpression(candidate)) {
      const callee = candidate.expression.getText(source).split(".").at(-1)
      if (callee === "assertOAuthDelegatedScope") {
        calls.push(candidate.getText(source).replace(/\s+/g, ""))
      }
    }
    ts.forEachChild(candidate, visit)
  }
  visit(node)
  return calls
}

describe("API mutation route boundary manifest", () => {
  it("discovers supported route files and rejects unscanned route extensions", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lyrashield-route-manifest-"))
    try {
      const javascriptRoute = path.join(root, "route.js")
      writeFileSync(javascriptRoute, "export function POST() {}")
      expect(walkRouteFiles(root)).toEqual([javascriptRoute])

      writeFileSync(path.join(root, "route.tsx"), "export function POST() {}")
      expect(() => walkRouteFiles(root)).toThrow(/unsupported App Router route file/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("classifies every exported POST, PUT, PATCH, and DELETE route", () => {
    const handlers = mutationExports()
    const boundaries = canonicalBoundaries()
    const expectedKeys = new Set([...boundaries.keys(), ...Object.keys(VERSIONED_ROUTE_ALIASES)])
    const actualKeys = new Set(handlers.keys())
    const unclassified = unclassifiedRoutes(actualKeys, expectedKeys)
    const stale = [...expectedKeys].filter((key) => !actualKeys.has(key)).sort()

    expect(unclassified, "Add an explicit boundary classification for each new mutation").toEqual(
      []
    )
    expect(stale, "Remove or correct classifications for deleted/renamed mutations").toEqual([])
    expect(boundaries.size + Object.keys(VERSIONED_ROUTE_ALIASES).length).toBe(131)
    expect(
      [...Object.values(BOUNDARY_GROUPS)].every((group) => group.description.trim().length > 0)
    ).toBe(true)
  })

  it("keeps each versioned mutation as an explicit alias of its canonical handler", () => {
    const handlers = mutationExports()
    const boundaries = canonicalBoundaries()
    for (const [alias, canonical] of Object.entries(VERSIONED_ROUTE_ALIASES)) {
      expect(handlers.get(alias)?.reexportTarget, `${alias} target`).toBe(canonical)
      expect(boundaries.has(canonical), `${alias} canonical boundary`).toBe(true)
    }
  })

  it("matches each documented boundary to its route implementation", () => {
    const handlers = mutationExports()
    for (const [category, group] of Object.entries(BOUNDARY_GROUPS)) {
      if (!group.marker) continue
      for (const key of group.routes) {
        const implementation = resolveImplementation(key, handlers)
        const implementationText = implementation.node.getText(implementation.source)
        const additionalMarkers =
          "additionalMarkers" in group ? (group.additionalMarkers ?? []) : []
        for (const marker of [group.marker, ...additionalMarkers]) {
          expect(implementationText, `${key} (${category})`).toContain(marker)
        }
      }
    }
  })

  it("retains target-scope assertions on every delegated mutation", () => {
    const handlers = mutationExports()
    const boundaries = canonicalBoundaries()
    const delegatedRoutes = Object.entries(BOUNDARY_GROUPS)
      .filter(([name]) => name === "delegatedTargetScope")
      .flatMap(([, group]) => group.routes)
      .sort()

    expect(delegatedRoutes).toEqual(Object.keys(EXPECTED_DELEGATED_SCOPE_CALLS).sort())
    for (const [key, expectedCall] of Object.entries(EXPECTED_DELEGATED_SCOPE_CALLS)) {
      expect(boundaries.get(key)?.marker, `${key} boundary marker`).toBe(
        "assertOAuthDelegatedScope"
      )
      const implementation = resolveImplementation(key, handlers)
      expect(delegatedScopeCalls(implementation.node, implementation.source), key).toContain(
        expectedCall.replace(/\s+/g, "")
      )
    }
  })

  it("keeps webhook-track disposition elevated and non-delegable", () => {
    const handlers = mutationExports()
    const boundaries = canonicalBoundaries()
    const delegatedRoutes = BOUNDARY_GROUPS.delegatedTargetScope.routes

    for (const [key, expected] of Object.entries(EXPECTED_ELEVATED_PLATFORM_ADMIN_MUTATIONS)) {
      expect(BOUNDARY_GROUPS.platformAdministrator.routes, `${key} admin classification`).toContain(
        key
      )
      expect(boundaries.get(key)?.marker, `${key} platform-admin boundary`).toBe(
        "requirePlatformAdmin"
      )
      expect(delegatedRoutes, `${key} must not be classified as delegable`).not.toContain(key)

      const implementation = resolveImplementation(key, handlers)
      const implementationText = implementation.node.getText(implementation.source)
      const normalizedImplementation = implementationText.replace(/\s+/g, "")

      expect(normalizedImplementation, `${key} elevation requirement`).toContain(
        expected.requestBoundary
      )
      expect(normalizedImplementation, `${key} elevation nonce forwarding`).toContain(
        expected.forwardedNonce
      )
      expect(normalizedImplementation, `${key} disposition handler`).toContain(expected.mutation)
      expect(delegatedScopeCalls(implementation.node, implementation.source), key).toEqual([])
    }
  })

  it("fails closed when an unclassified mutation is added", () => {
    const boundaries = canonicalBoundaries()
    const classified = new Set([...boundaries.keys(), ...Object.keys(VERSIONED_ROUTE_ALIASES)])
    const addedRoute = "new-feature/route#POST"
    const unclassified = unclassifiedRoutes([...classified, addedRoute], classified)
    expect(unclassified).toEqual([addedRoute])
  })
})
