import { isValidElement, type ReactElement, type ReactNode } from "react"
import { expect, it, vi } from "vitest"
const state = vi.hoisted(() => ({ status: "active" }))
vi.mock("@/lib/cache", () => ({
  getCachedSession: async () => ({ userId: "u1" }),
  getCachedWorkspaceId: async () => "ws1",
}))
vi.mock("@lyrashield/auth/server", () => ({
  getWorkspaceMembership: async () => ({ role: "OWNER" }),
}))
vi.mock("@lyrashield/config", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://example.test" } }))
vi.mock("@lyrashield/db", () => ({
  prisma: {
    integration: {
      findMany: async () => [
        { type: "GITHUB", status: state.status, metadata: { accountLogin: "example" } },
      ],
    },
  },
}))
vi.mock("./github-integration", () => ({ GithubIntegration: () => null }))
vi.mock("./mcp-integration", () => ({ McpIntegration: () => null }))
vi.mock("./cli-integration", () => ({ CliIntegration: () => null }))
import IntegrationsPage from "./page"
import { GithubIntegration } from "./github-integration"
function find(
  node: ReactNode
): ReactElement<{ connected: boolean; accountLogin: unknown }> | undefined {
  if (Array.isArray(node)) return node.map(find).find(Boolean)
  if (!isValidElement<{ children?: ReactNode }>(node)) return
  if (node.type === GithubIntegration)
    return node as ReactElement<{ connected: boolean; accountLogin: unknown }>
  return find(node.props.children)
}
it.each(["inactive", "revoked", "suspended"])(
  "does not present a %s GitHub integration as connected",
  async (status) => {
    state.status = status
    const tree = await IntegrationsPage({ searchParams: Promise.resolve({}) })
    expect(find(tree)?.props.connected).toBe(false)
    expect(find(tree)?.props.accountLogin).toBeFalsy()
  }
)
it("shows the active GitHub connection", async () => {
  state.status = "active"
  const tree = await IntegrationsPage({ searchParams: Promise.resolve({}) })
  expect(find(tree)?.props.connected).toBe(true)
})
