"use client"

import { useState } from "react"
import { Wrench, GitPullRequest, ShieldCheck, ExternalLink } from "lucide-react"
import { Badge, Card, EmptyState, LoadMore } from "@lyrashield/ui"
import { apiGetPaginated } from "@/lib/api-client"
import { formatDate } from "@/lib/date-format"

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
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Fixes</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Review fix proposals and track pull requests for your findings.
          </p>
        </div>
      </div>

      {proposals.length === 0 && !nextCursor ? (
        <EmptyState
          icon={Wrench}
          title="No fix proposals yet"
          description="When scans detect findings, you can generate fix proposals and create pull requests from the findings page."
        />
      ) : (
        <div className="space-y-3">
          {proposals.map((proposal) => (
            <Card
              key={proposal.id}
              className="group p-5 transition-all duration-200 hover:shadow-md"
            >
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <Badge variant={PROPOSAL_STATUS_BADGE[proposal.status] ?? "muted"}>
                    {proposal.status}
                  </Badge>
                  <Badge variant={SEVERITY_BADGE[proposal.finding.severity] ?? "muted"}>
                    {proposal.finding.severity}
                  </Badge>
                  {proposal.safetyScore != null && (
                    <Badge variant={proposal.safetyScore >= 80 ? "success" : "warning"}>
                      Safety: {proposal.safetyScore}
                    </Badge>
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
                  {proposal.generatedByModel && <span>AI: {proposal.generatedByModel}</span>}
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
              const res = await apiGetPaginated<FixProposalItem>(`/api/fix-proposals`, {
                workspaceId,
                cursor,
              })
              return { items: res.items as unknown[], nextCursor: res.nextCursor }
            }}
            onItems={(items) => setProposals((prev) => [...prev, ...(items as FixProposalItem[])])}
            onNextCursor={setNextCursor}
          />
        </div>
      )}
    </div>
  )
}
