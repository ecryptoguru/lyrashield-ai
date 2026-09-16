"use client"

import Link from "next/link"
import { Plus, Crosshair, Bug, Globe, GitBranch, Trash2 } from "lucide-react"
import { Button, Badge, EmptyState } from "@lyrashield/ui"
import { InlineConfirm } from "@/components/ui/inline-confirm"
import { TARGET_PLURAL, TARGET_SINGULAR, RUN_PLURAL, ISSUE_PLURAL } from "@/lib/terminology"
import { getTargetTypeLabel } from "@/lib/enum-labels"
import { humanizeToken } from "@/lib/labels"
import type { Target } from "./targets-model"

export function TargetsEmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <EmptyState
      icon={Crosshair}
      title={`No ${TARGET_PLURAL.toLowerCase()} yet`}
      description="Add a repository or URL target to start scanning."
      action={
        <Button onClick={onAdd}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add {TARGET_SINGULAR.toLowerCase()}
        </Button>
      }
    />
  )
}

export function TargetsTable({
  targets,
  onDelete,
}: {
  targets: Target[]
  onDelete: (target: Target) => void
}) {
  return (
    <div
      className="w-full min-w-0 max-w-full overflow-x-auto rounded-xl border shadow-sm [contain:paint]"
      tabIndex={0}
      aria-label="Targets list"
    >
      <table className="w-full min-w-[40rem] text-sm">
        <thead className="bg-muted/30 border-b">
          <tr>
            <th scope="col" className="px-4 py-3 text-left font-semibold">
              Name
            </th>
            <th scope="col" className="px-4 py-3 text-left font-semibold">
              Type
            </th>
            <th scope="col" className="px-4 py-3 text-left font-semibold">
              Domain verification
            </th>
            <th scope="col" className="hidden px-4 py-3 text-left font-semibold lg:table-cell">
              {RUN_PLURAL}
            </th>
            <th scope="col" className="hidden px-4 py-3 text-left font-semibold lg:table-cell">
              {ISSUE_PLURAL}
            </th>
            <th scope="col" className="hidden px-4 py-3 text-left font-semibold sm:table-cell">
              Status
            </th>
            <th scope="col" className="hidden px-4 py-3 text-left font-semibold sm:table-cell">
              <span className="sr-only">View</span>
            </th>
            <th scope="col" className="hidden px-4 py-3 text-left font-semibold sm:table-cell">
              <span className="sr-only">Delete</span>
            </th>
            <th scope="col" className="sr-only">
              <span className="sr-only">
                {RUN_PLURAL} and {ISSUE_PLURAL} summary
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {targets.map((t) => (
            <tr key={t.id} className="hover:bg-muted/30 border-b last:border-0">
              <td className="overflow-hidden px-4 py-3">
                <Link
                  href={`/dashboard/targets/${t.id}`}
                  className="block truncate font-medium hover:underline"
                  aria-label={`View ${TARGET_SINGULAR.toLowerCase()} ${t.name}`}
                >
                  {t.name}
                </Link>
                {t.repoFullName && (
                  <div className="text-muted-foreground truncate text-xs">{t.repoFullName}</div>
                )}
                {t.url && <div className="text-muted-foreground truncate text-xs">{t.url}</div>}
              </td>
              <td className="px-4 py-3">
                <Badge>
                  {t.type === "REPO" ? (
                    <GitBranch className="h-3 w-3" aria-hidden="true" />
                  ) : (
                    <Globe className="h-3 w-3" aria-hidden="true" />
                  )}
                  {getTargetTypeLabel(t.type)}
                </Badge>
              </td>
              <td className="px-4 py-3">
                <Badge
                  variant={
                    t.domainVerificationStatus?.startsWith("Verified until") ? "success" : "muted"
                  }
                >
                  {t.domainVerificationStatus ??
                    (t.type === "WEB_APP" || t.type === "API" ? "Not verified" : "Not applicable")}
                </Badge>
              </td>
              <td className="hidden px-4 py-3 lg:table-cell">{t.scanCount}</td>
              <td className="hidden px-4 py-3 lg:table-cell">
                {t.findingCount > 0 ? (
                  <span className="text-destructive flex items-center gap-1">
                    <Bug className="h-3 w-3" aria-hidden="true" />
                    {t.findingCount}
                  </span>
                ) : (
                  "0"
                )}
              </td>
              <td className="hidden px-4 py-3 sm:table-cell">
                <Badge variant={t.status === "active" ? "success" : "muted"}>
                  {humanizeToken(t.status)}
                </Badge>
              </td>
              <td className="hidden px-4 py-3 sm:table-cell">
                <Link
                  href={`/dashboard/targets/${t.id}`}
                  className="text-primary text-xs font-medium hover:underline"
                  aria-label={`View ${TARGET_SINGULAR.toLowerCase()} ${t.name}`}
                >
                  View
                </Link>
              </td>
              <td className="hidden px-4 py-3 sm:table-cell">
                <InlineConfirm
                  triggerIcon={<Trash2 className="h-4 w-4" aria-hidden="true" />}
                  aria-label={`Delete ${TARGET_SINGULAR.toLowerCase()} ${t.name}`}
                  message={`Delete ${t.name}? Scans, findings, verdicts and reports stay in the workspace.`}
                  confirmLabel="Delete"
                  onConfirm={() => onDelete(t)}
                />
              </td>
              {/* Mobile/AT fallback: Runs and Issues columns are hidden
                  below lg, so the primary row data is otherwise
                  unreachable on small screens. Announce counts + status
                  without affecting the visual layout. */}
              <td className="sr-only">
                <span className="sr-only">{`${humanizeToken(t.status)}, ${t.scanCount} ${RUN_PLURAL.toLowerCase()}, ${t.findingCount} ${ISSUE_PLURAL.toLowerCase()}`}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
