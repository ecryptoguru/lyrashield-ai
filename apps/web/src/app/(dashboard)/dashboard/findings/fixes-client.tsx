"use client"

import { useState } from "react"
import { Wrench, GitPullRequest, ShieldCheck, ExternalLink, Info } from "lucide-react"
import Link from "next/link"
import { Badge, buttonVariants, Card, EmptyState, LoadMore } from "@lyrashield/ui"
import { z } from "zod"
import { paginatedResponseSchema } from "@/lib/api-schemas"
import { apiGetPaginated } from "@/lib/api-client"
import { formatDate } from "@/lib/date-format"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { severityLabel, humanizeToken } from "@/lib/labels"
import { SEVERITY_BADGE } from "@/lib/severity-badge"
import { findingsHref } from "@/lib/finding-list-params"
import { CreateFixPrAction } from "@/components/create-fix-pr-action"

type BadgeVariant = "default" | "success" | "danger" | "warning" | "info" | "muted"

const PROPOSAL_STATUS_BADGE: Record<string, BadgeVariant> = {
  draft: "muted",
  ready: "info",
  failed: "danger",
  approved: "info",
  pr_opened: "info",
  pr_merged: "success",
  pr_closed: "muted",
  rejected: "danger",
}
const PROPOSAL_STATUS_LABEL: Record<string, string> = {
  ready: "Ready for review",
  failed: "Generation failed",
}

interface FixProposalItem {
  id: string
  kind: string
  summary: string
  status: string
  hasStoredPatch?: boolean
  safetyScore?: number | null
  generatedByModel?: string | null
  createdAt: string
  finding: {
    id: string
    title: string
    severity: string
    status: string
    cwe?: string | null
    target?: { id: string; name: string; repoFullName?: string | null } | null
  }
  pullRequests: Array<{
    id: string
    provider: string
    repoOwner: string
    repoName: string
    branchName: string
    prNumber?: number | null
    prUrl?: string | null
    status: string
  }>
}

const fixProposalItemSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    summary: z.string(),
    status: z.string(),
    hasStoredPatch: z.boolean().optional(),
    safetyScore: z.number().nullable().optional(),
    generatedByModel: z.string().nullable().optional(),
    createdAt: z.string().datetime().or(z.string()),
    finding: z
      .object({
        id: z.string(),
        title: z.string(),
        severity: z.string(),
        status: z.string(),
        cwe: z.string().nullable().optional(),
        target: z
          .object({
            id: z.string(),
            name: z.string(),
            repoFullName: z.string().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough(),
    pullRequests: z.array(
      z
        .object({
          id: z.string(),
          provider: z.string(),
          repoOwner: z.string(),
          repoName: z.string(),
          branchName: z.string(),
          prNumber: z.number().nullable().optional(),
          prUrl: z.string().nullable().optional(),
          status: z.string(),
        })
        .passthrough()
    ),
  })
  .passthrough()

const fixProposalsPaginatedSchema = paginatedResponseSchema(fixProposalItemSchema)

function ProposalReviewDetails({ kind, summary }: Pick<FixProposalItem, "kind" | "summary">) {
  return (
    <>
      {kind === "composer_update" && (
        <p className="border-warning/30 bg-warning/5 mt-3 rounded-md border p-3 text-sm">
          <strong>Application compatibility is unverified.</strong> Review the draft pull request
          and run your application tests before merging. Lockfile consistency does not verify
          application behavior.
        </p>
      )}
      <details className="mt-3 min-w-0 rounded-md border p-3">
        <summary className="focus-visible:ring-ring cursor-pointer rounded text-sm font-medium focus-visible:ring-2 focus-visible:outline-none">
          Review full proposal
        </summary>
        <p className="text-muted-foreground mt-2 whitespace-pre-wrap wrap-break-word text-sm">
          {summary}
        </p>
      </details>
    </>
  )
}

/**
 * The Findings → Proposed fixes tab: every fix proposal in the workspace with
 * its parent finding, safety score, and pull requests. Formerly the
 * independent /dashboard/fixes page (Deep Review v16 3.2); the section tabs on
 * the Findings page own the heading, so this renders the list only.
 */
export function FixesClient({
  workspaceId,
  canCreatePr = false,
  targetId,
  observedInScanId,
  initialData,
  initialNextCursor,
}: {
  workspaceId: string
  canCreatePr?: boolean
  targetId?: string
  observedInScanId?: string
  initialData: FixProposalItem[]
  initialNextCursor: string | null
}) {
  const [proposals, setProposals] = useState<FixProposalItem[]>(initialData)
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor)

  return (
    <div>
      {proposals.length === 0 && !nextCursor ? (
        <EmptyState
          icon={Wrench}
          title="No proposed fixes yet"
          description="Open a finding to record a fix proposal. Proposals with a stored patch can request a pull request after human approval. A summary alone does not change your code."
          action={
            <Link
              href={findingsHref({
                tab: "issues",
                ...(observedInScanId ? { scanId: observedInScanId } : {}),
                ...(targetId ? { target: targetId } : {}),
              })}
              className={buttonVariants()}
            >
              Review findings
            </Link>
          }
        />
      ) : (
        <div className="space-y-3">
          {proposals.map((proposal) => (
            <Card
              key={proposal.id}
              role="article"
              aria-label={`Proposed fix for ${proposal.finding.title}`}
              className="group p-5 transition-[border-color,box-shadow] duration-(--duration-base) ease-out hover:shadow-md"
            >
              <div>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge variant={PROPOSAL_STATUS_BADGE[proposal.status] ?? "muted"}>
                    {PROPOSAL_STATUS_LABEL[proposal.status] ?? humanizeToken(proposal.status)}
                  </Badge>
                  <Badge variant={SEVERITY_BADGE[proposal.finding.severity] ?? "muted"}>
                    {severityLabel(proposal.finding.severity)}
                  </Badge>
                  {proposal.safetyScore != null && (
                    <div className="flex items-center gap-1">
                      <Badge variant="muted">Review score: {proposal.safetyScore}</Badge>
                      <Tooltip>
                        <TooltipTrigger aria-label="What the review score means">
                          <Info className="text-muted-foreground size-3.5" aria-hidden="true" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          A reported estimate for review (0–100). It does not verify security,
                          correctness or application compatibility.
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  )}
                </div>

                <h3 className="wrap-break-word font-semibold">{proposal.finding.title}</h3>
                <p className="text-muted-foreground mt-1 line-clamp-2 wrap-break-word text-sm">
                  {proposal.summary}
                </p>
                <ProposalReviewDetails kind={proposal.kind} summary={proposal.summary} />

                <div className="text-muted-foreground mt-3 flex flex-wrap items-center gap-3 text-xs">
                  {proposal.finding.cwe && (
                    <span className="flex items-center gap-1">
                      <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                      {proposal.finding.cwe}
                    </span>
                  )}
                  {proposal.finding.target && <span>{proposal.finding.target.name}</span>}
                  {proposal.generatedByModel && (
                    <span className="flex items-center gap-1">
                      AI: {proposal.generatedByModel}
                      <Tooltip>
                        <TooltipTrigger aria-label="What generated by model means">
                          <Info className="text-muted-foreground size-3.5" aria-hidden="true" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          The AI model that generated this proposed fix.
                        </TooltipContent>
                      </Tooltip>
                    </span>
                  )}
                  <span>{formatDate(proposal.createdAt)}</span>
                </div>

                <ProposalAction
                  proposal={proposal}
                  workspaceId={workspaceId}
                  canCreatePr={canCreatePr}
                />

                {/* Deep link to the finding this proposal patches — the drawer's
                    `?finding=` contract, same as everywhere else in this app. */}
                <Link
                  href={findingsHref({
                    tab: "issues",
                    finding: proposal.finding.id,
                    ...(observedInScanId ? { scanId: observedInScanId } : {}),
                    ...((targetId ?? proposal.finding.target?.id)
                      ? { target: targetId ?? proposal.finding.target?.id }
                      : {}),
                  })}
                  className="text-muted-foreground hover:text-foreground mt-3 inline-flex text-xs underline underline-offset-4"
                >
                  View the finding
                </Link>

                {proposal.pullRequests.length > 0 && (
                  <div className="mt-3 space-y-1">
                    {proposal.pullRequests.map((pr) => {
                      const label = `${pr.repoOwner}/${pr.repoName}${pr.prNumber != null ? ` #${pr.prNumber}` : ""}`
                      return pr.prUrl ? (
                        <a
                          key={pr.id}
                          href={pr.prUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary inline-flex items-center gap-2 text-xs hover:underline"
                        >
                          <GitPullRequest className="h-3.5 w-3.5" aria-hidden="true" />
                          {label}
                          <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        </a>
                      ) : (
                        <span
                          key={pr.id}
                          className="text-muted-foreground inline-flex items-center gap-2 text-xs"
                        >
                          <GitPullRequest className="h-3.5 w-3.5" aria-hidden="true" />
                          {label} ·{" "}
                          {pr.status === "recovery"
                            ? "Recovery needed"
                            : pr.status === "opening"
                              ? "Opening"
                              : pr.status === "stale"
                                ? "Stale patch"
                                : pr.status === "failed"
                                  ? "Execution failed"
                                  : "Link pending"}
                        </span>
                      )
                    })}
                  </div>
                )}
              </div>
            </Card>
          ))}

          <LoadMore
            key={`${workspaceId}:${observedInScanId ?? ""}:${targetId ?? ""}`}
            cursor={nextCursor}
            onLoadMore={(cursor) => loadMoreFixes(cursor, workspaceId, targetId, observedInScanId)}
            onItems={(items) => setProposals((prev) => [...prev, ...items])}
            onNextCursor={setNextCursor}
          />
        </div>
      )}
    </div>
  )
}

function ProposalAction({
  proposal,
  workspaceId,
  canCreatePr,
}: {
  proposal: FixProposalItem
  workspaceId: string
  canCreatePr: boolean
}) {
  if (!canCreatePr || proposal.status !== "ready" || !proposal.hasStoredPatch) return null
  return (
    <div className="mt-3">
      <CreateFixPrAction
        workspaceId={workspaceId}
        proposalId={proposal.id}
        hasExecution={Boolean(proposal.pullRequests?.length)}
        prominent
      />
    </div>
  )
}

async function loadMoreFixes(
  cursor: string,
  workspaceId: string,
  targetId?: string,
  observedInScanId?: string
) {
  try {
    const res = await apiGetPaginated<FixProposalItem>(
      "/api/fix-proposals",
      {
        workspaceId,
        cursor,
        ...(targetId ? { targetId } : {}),
        ...(observedInScanId ? { observedInScanId } : {}),
      },
      { schema: fixProposalsPaginatedSchema }
    )
    return { items: res.items, nextCursor: res.nextCursor }
  } catch {
    throw new Error("Failed to load more fix proposals. Try again.")
  }
}
