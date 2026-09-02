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
import { severityLabel } from "@/lib/labels"
import { PageHeader } from "@/components/page-header"

type BadgeVariant = "default" | "success" | "danger" | "warning" | "info" | "muted"

const SEVERITY_BADGE: Record<string, BadgeVariant> = {
  CRITICAL: "danger",
  HIGH: "danger",
  MEDIUM: "warning",
  LOW: "info",
  INFO: "muted",
}

const PROPOSAL_STATUS_BADGE: Record<string, BadgeVariant> = {
  draft: "muted",
  approved: "info",
  pr_opened: "info",
  pr_merged: "success",
  pr_closed: "muted",
  rejected: "danger",
}

export interface FixProposalItem {
  id: string
  kind: string
  summary: string
  status: string
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

export function FixesClient({
  workspaceId,
  initialData,
  initialNextCursor,
}: {
  workspaceId: string
  initialData: FixProposalItem[]
  initialNextCursor: string | null
}) {
  const [proposals, setProposals] = useState<FixProposalItem[]>(initialData)
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor)

  return (
    <div>
      <PageHeader
        title="Proposed fixes"
        description="Review proposed fixes and track pull requests for your issues."
      />

      {proposals.length === 0 && !nextCursor ? (
        <EmptyState
          icon={Wrench}
          title="No proposed fixes yet"
          description="Open an issue to record a fix proposal. Proposals with a stored patch can request a pull request after human approval. A summary alone does not change your code."
          action={
            <Link href="/dashboard/findings" className={buttonVariants()}>
              Review issues
            </Link>
          }
        />
      ) : (
        <div className="space-y-3">
          {proposals.map((proposal) => (
            <Card
              key={proposal.id}
              className="group p-5 transition-[border-color,box-shadow] duration-(--duration-base) ease-out hover:shadow-md"
            >
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <Badge variant={PROPOSAL_STATUS_BADGE[proposal.status] ?? "muted"}>
                    {proposal.status}
                  </Badge>
                  <Badge variant={SEVERITY_BADGE[proposal.finding.severity] ?? "muted"}>
                    {severityLabel(proposal.finding.severity)}
                  </Badge>
                  {proposal.safetyScore != null && (
                    <div className="flex items-center gap-1">
                      <Badge variant={proposal.safetyScore >= 80 ? "success" : "warning"}>
                        Safety: {proposal.safetyScore}
                      </Badge>
                      <Tooltip>
                        <TooltipTrigger aria-label="What the safety score means">
                          <Info className="text-muted-foreground size-3.5" aria-hidden="true" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          Estimated confidence that the proposed change is safe and correct (0–100).
                          Higher is safer.
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  )}
                </div>

                <h3 className="truncate font-semibold" title={proposal.finding.title}>
                  {proposal.finding.title}
                </h3>
                <p className="text-muted-foreground mt-1 line-clamp-2 text-sm">
                  {proposal.summary}
                </p>

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
                          {label} · Link pending
                        </span>
                      )
                    })}
                  </div>
                )}
              </div>
            </Card>
          ))}

          <LoadMore
            cursor={nextCursor}
            onLoadMore={async (cursor) => {
              const res = await apiGetPaginated<FixProposalItem>(
                `/api/fix-proposals`,
                {
                  workspaceId,
                  cursor,
                },
                { schema: fixProposalsPaginatedSchema }
              )
              return { items: res.items, nextCursor: res.nextCursor }
            }}
            onItems={(items) => setProposals((prev) => [...prev, ...items])}
            onNextCursor={setNextCursor}
          />
        </div>
      )}
    </div>
  )
}
