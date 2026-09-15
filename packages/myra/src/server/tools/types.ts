import type { MyraComponent, MyraPrincipal, MyraSurface } from "../../contracts"
import type { MyraDb } from "../db"

/** Everything a tool needs — resolved by the service layer, never the model. */
export interface MyraToolContext {
  principal: MyraPrincipal
  surface: MyraSurface
  conversationId: string | null
  /** Verified active workspace (authenticated users on DASHBOARD only). */
  workspaceId: string | null
  role: string | null
  routeContext?: string | null
  db?: MyraDb
  /** Test seams for external boundaries (billing, calendar). Production omits. */
  deps?: {
    resolveAccountBilling?: typeof import("@lyrashield/billing").resolveAccountBilling
    getAccountTrialState?: typeof import("@lyrashield/billing").getAccountTrialState
    getUsageBalance?: typeof import("@lyrashield/billing").getUsageBalance
    evaluateScanEntitlement?: typeof import("@lyrashield/billing").evaluateScanEntitlement
  }
}

export interface ProposalSummary {
  id: string
  operationName: string
  title: string
  description: string
  payloadPreview: Record<string, unknown>
  expiresAt: string
}

export interface MyraToolResult {
  /** Structured data summarized for the provider — never rendered raw. */
  data: Record<string, unknown>
  components?: MyraComponent[]
  proposals?: ProposalSummary[]
}

export type ToolRunner = (
  ctx: MyraToolContext,
  input: unknown
) => Promise<MyraToolResult>
