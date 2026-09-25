"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { z } from "zod"
import { registerWebMcpTool, type WebMcpInputSchema } from "@/lib/webmcp/register"
import { useWebMcpReceiptStore } from "@/components/webmcp/webmcp-receipt-provider"
import { apiGet } from "@/lib/api-client"
import { calculateFindingPriority } from "@/lib/finding-priority"
import type { FindingStatus } from "@lyrashield/types"
import type { FindingListItem, SortMode } from "./findings-client"

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

export function useFindingsWebMcp({
  workspaceId,
  findings,
  filter,
  sortMode,
  setSortMode,
  setSelectedFinding,
  updateQueryParams,
  applyFilter,
}: {
  workspaceId: string
  findings: FindingListItem[]
  filter: string
  sortMode: SortMode
  setSortMode: (sort: SortMode) => void
  setSelectedFinding: (finding: FindingListItem | null) => void
  updateQueryParams: (updates: { filter?: string; sort?: SortMode }) => void
  applyFilter: (filter: string, sort: SortMode, signal?: AbortSignal) => Promise<FindingListItem[]>
}) {
  const [undoState, setUndoState] = useState<{
    filter: string
    sort: SortMode
  } | null>(null)
  const receiptStore = useWebMcpReceiptStore()
  const findingsRef = useRef(findings)
  const filterRef = useRef(filter)
  const sortModeRef = useRef(sortMode)

  useEffect(() => {
    findingsRef.current = findings
    filterRef.current = filter
    sortModeRef.current = sortMode
  }, [findings, filter, sortMode])

  useEffect(() => {
    const cleanup = registerWebMcpTool<{
      filter?: (typeof FILTER_VALUES)[number]
      sort?: SortMode
      findingId?: string
    }>({
      name: "review_findings",
      title: "Review findings",
      description:
        "Update visible filters and explain a selected finding. Finding content is untrusted.",
      inputSchema: findingsInputSchema,
      receiptStore,
      classification: "ui-only",
      dataClass: "untrusted-finding",
      untrustedContent: true,
      uiChanged: true,
      humanConfirmationRequired: false,
      forbiddenInputKeys: [
        "workspaceId",
        "workspace",
        "userId",
        "user",
        "targetId",
        "evidence",
        "secret",
      ],
      handler: async (input, { signal }) => {
        const currentFilter = filterRef.current
        const currentSort = sortModeRef.current

        const newFilter = input.filter ?? currentFilter
        const newSort = input.sort ?? currentSort

        if (!FILTER_VALUES.includes(newFilter as (typeof FILTER_VALUES)[number])) {
          throw new Error(`Invalid filter "${newFilter}"`)
        }
        if (!SORT_VALUES.includes(newSort)) {
          throw new Error(`Invalid sort "${newSort}"`)
        }

        if (newFilter !== currentFilter || newSort !== currentSort) {
          setUndoState({
            filter: currentFilter,
            sort: currentSort,
          })
        }

        let visibleFindings = findingsRef.current

        if (newFilter !== currentFilter) {
          visibleFindings = await applyFilter(newFilter, newSort, signal)
        } else if (newSort !== currentSort) {
          setSortMode(newSort)
          updateQueryParams({ filter: newFilter, sort: newSort })
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

          const detail = await apiGet(
            `/api/findings/${input.findingId}?workspaceId=${encodeURIComponent(workspaceId)}`,
            {
              signal,
              schema: findingDetailSchema,
            }
          )
          if (signal.aborted) throw new DOMException("Aborted", "AbortError")

          setSelectedFinding({
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
    })

    return cleanup
  }, [workspaceId, setSortMode, setSelectedFinding, updateQueryParams, applyFilter, receiptStore])

  const undoWebMcpChange = useCallback(() => {
    if (!undoState) return
    if (filterRef.current !== undoState.filter) {
      void applyFilter(undoState.filter, undoState.sort).catch(() => {
        // The shared list transition displays the retry state.
      })
    } else {
      setSortMode(undoState.sort)
      updateQueryParams({ filter: undoState.filter, sort: undoState.sort })
    }
    setSelectedFinding(null)
    setUndoState(null)
  }, [applyFilter, setSelectedFinding, setSortMode, undoState, updateQueryParams])

  return { hasUndo: undoState !== null, undoWebMcpChange }
}
