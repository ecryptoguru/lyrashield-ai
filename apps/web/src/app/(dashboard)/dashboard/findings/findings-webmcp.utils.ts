/**
 * `review_findings` — the findings page's WebMCP tool definition, plus the
 * undo action backing the drawer's Undo affordance.
 *
 * The tool filters and explains only the findings currently visible on the
 * page (the workspace is bound at registration, never from agent input).
 * Filter and sort changes go through the page's own `applyFilter` path — the
 * same URL-synced refetch a human click performs — and the prior view is
 * captured so the drawer can offer an undo.
 */
import { z } from "zod"
import { apiGet } from "@/lib/api-client"
import { calculateFindingPriority } from "@/lib/finding-priority"
import type { FindingStatus } from "@lyrashield/types"
import type { WebMcpInputSchema, WebMcpPageTool } from "@/lib/webmcp/register"
import type { FindingListItem, SortMode } from "./findings-client"

/**
 * Inputs the tool must never accept from an agent: tenancy, principals and
 * foreign resource ids are bound to the page's own session and visible list.
 */
export const FINDINGS_WEBMCP_FORBIDDEN_INPUT_KEYS = [
  "workspaceId",
  "workspace",
  "userId",
  "user",
  "targetId",
  "evidence",
  "secret",
] as const

const FILTER_VALUES = [
  "ALL",
  "OPEN",
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
  "FIXED",
  "VERIFIED",
] as const
const SORT_VALUES = ["priority", "severity", "newest"] as const

const findingsInputSchema: WebMcpInputSchema = {
  properties: {
    filter: {
      type: "string",
      description: "Filter the findings list.",
      enum: [...FILTER_VALUES],
    },
    sort: {
      type: "string",
      description: "Sort the findings list.",
      enum: [...SORT_VALUES],
    },
    findingId: {
      type: "string",
      description: "Optional currently visible finding to explain.",
    },
  },
}

const findingDetailSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    summary: z.string(),
    cwe: z.string().nullable().optional(),
    cvssScore: z.number().nullable().optional(),
    businessImpact: z.string().nullable().optional(),
    exploitability: z.string().nullable().optional(),
    plainLanguage: z
      .object({
        title: z.string(),
        whatItIs: z.string(),
        whyItMatters: z.string(),
        howToFix: z.string(),
        difficulty: z.string(),
        estimatedTimeToFix: z.string(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

/** Prior view state captured before a tool-applied filter/sort change —
 * exactly what the drawer's Undo restores. */
export interface FindingsWebMcpUndoState {
  filter: string
  sort: SortMode
}

export interface ReviewFindingsToolDeps {
  workspaceId: string
  /** Findings currently visible in the page's list. */
  getFindings: () => FindingListItem[]
  /** Currently applied filter value. */
  getFilter: () => string
  /** Currently applied sort mode. */
  getSortMode: () => SortMode
  setSortMode: (sort: SortMode) => void
  setSelectedFinding: (finding: FindingListItem | null) => void
  /** The page's URL-syncing query-param writer. */
  updateQueryParams: (updates: { filter?: string; sort?: SortMode }) => void
  /** The page's own filter+sort apply path (refetch through the same query). */
  applyFilter: (filter: string, sort: SortMode, signal?: AbortSignal) => Promise<FindingListItem[]>
  /** Records/clears the prior view for the drawer Undo affordance. */
  setUndoState: (state: FindingsWebMcpUndoState | null) => void
}

type ReviewFindingsInput = {
  filter?: (typeof FILTER_VALUES)[number]
  sort?: SortMode
  findingId?: string
}

/** The `review_findings` registration options minus the receipt store. */
export function createReviewFindingsTool(
  deps: ReviewFindingsToolDeps
): WebMcpPageTool<ReviewFindingsInput> {
  return {
    name: "review_findings",
    title: "Review findings",
    description:
      "Update visible filters and explain a selected finding. Finding content is untrusted.",
    inputSchema: findingsInputSchema,
    classification: "ui-only",
    dataClass: "untrusted-finding",
    untrustedContent: true,
    uiChanged: true,
    durableMutation: false,
    humanConfirmationRequired: false,
    forbiddenInputKeys: FINDINGS_WEBMCP_FORBIDDEN_INPUT_KEYS,
    handler: async (input, { signal }) => {
      const currentFilter = deps.getFilter()
      const currentSort = deps.getSortMode()

      const newFilter = input.filter ?? currentFilter
      const newSort = input.sort ?? currentSort

      if (!FILTER_VALUES.includes(newFilter as (typeof FILTER_VALUES)[number])) {
        throw new Error(`Invalid filter "${newFilter}"`)
      }
      if (!SORT_VALUES.includes(newSort)) {
        throw new Error(`Invalid sort "${newSort}"`)
      }

      if (newFilter !== currentFilter || newSort !== currentSort) {
        deps.setUndoState({
          filter: currentFilter,
          sort: currentSort,
        })
      }

      let visibleFindings = deps.getFindings()

      // A filter/sort change is a UI-level, in-app action: route it through
      // the page's own apply path (URL sync + refetch), not a side channel.
      if (newFilter !== currentFilter) {
        visibleFindings = await deps.applyFilter(newFilter, newSort, signal)
      } else if (newSort !== currentSort) {
        deps.setSortMode(newSort)
        deps.updateQueryParams({ filter: newFilter, sort: newSort })
      }

      const selected = input.findingId
        ? visibleFindings.find((f) => f.id === input.findingId)
        : null

      let explanation: Record<string, unknown> | null = null

      if (input.findingId) {
        if (!selected) {
          throw new Error(
            `Finding "${input.findingId}" is not currently visible. Select it from the list first.`
          )
        }

        // Detail read through the page's own authenticated path.
        const detail = await apiGet(
          `/api/findings/${input.findingId}?workspaceId=${encodeURIComponent(deps.workspaceId)}`,
          {
            signal,
            schema: findingDetailSchema,
          }
        )
        if (signal.aborted) throw new DOMException("Aborted", "AbortError")

        deps.setSelectedFinding({
          ...selected,
          priority:
            selected.priority ??
            calculateFindingPriority({
              severity: selected.severity,
              status: selected.status as FindingStatus,
              verified: selected.verified,
              confidence: selected.confidence,
              environment: selected.target?.environment as
                "LOCAL" | "PREVIEW" | "STAGING" | "PRODUCTION" | null | undefined,
              businessImpact: selected.businessImpact,
              exploitability: selected.exploitability,
            }),
        })

        const plain = detail.plainLanguage
        explanation = {
          title: detail.title,
          summary: detail.summary,
          untrustedContent: true,
          plainLanguage: plain
            ? {
                whatItIs: plain.whatItIs,
                whyItMatters: plain.whyItMatters,
                howToFix: plain.howToFix,
                difficulty: plain.difficulty,
                estimatedTimeToFix: plain.estimatedTimeToFix,
              }
            : null,
          note: "Finding details are generated by a scanner and should be verified before acting.",
        }
      }

      return {
        filter: newFilter,
        sort: newSort,
        visibleCount: input.findingId ? 1 : visibleFindings.length,
        explanation,
      }
    },
  }
}

/**
 * The undo action behind the drawer's Undo affordance: restores the captured
 * prior view through the same page apply path the tool used, then clears the
 * undo state. A no-op when no prior view was captured.
 */
export async function runFindingsWebMcpUndo(
  undo: FindingsWebMcpUndoState | null,
  deps: Pick<
    ReviewFindingsToolDeps,
    | "getFilter"
    | "setSortMode"
    | "setSelectedFinding"
    | "updateQueryParams"
    | "applyFilter"
    | "setUndoState"
  >
): Promise<void> {
  if (!undo) return
  if (deps.getFilter() !== undo.filter) {
    await deps.applyFilter(undo.filter, undo.sort)
  } else {
    deps.setSortMode(undo.sort)
    deps.updateQueryParams({ filter: undo.filter, sort: undo.sort })
  }
  deps.setSelectedFinding(null)
  deps.setUndoState(null)
}
