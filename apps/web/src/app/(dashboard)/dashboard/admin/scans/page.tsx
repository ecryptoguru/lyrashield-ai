import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { requirePlatformAdminIdentity } from "@lyrashield/auth/server"
import { Badge, buttonVariants } from "@lyrashield/ui"
import { PageHeader } from "@/components/page-header"
import { getPlatformAdminScans, parseAdminCursor } from "@/lib/platform-admin-lists"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Scan operations",
}

export default async function PlatformAdminScansPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>
}) {
  const identity = await requirePlatformAdminIdentity().catch(() => notFound())

  const cursor = parseAdminCursor((await searchParams).cursor)
  const page = await getPlatformAdminScans(identity, cursor)

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Scan operations"
        description="Status and timing metadata only. Findings, source content, errors, tokens, and model costs are excluded."
      />
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-5xl text-left text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Mode</th>
              <th className="px-4 py-3 font-medium">Workspace</th>
              <th className="px-4 py-3 font-medium">Target</th>
              <th className="px-4 py-3 font-medium">Created</th>
              <th className="px-4 py-3 font-medium">Started</th>
              <th className="px-4 py-3 font-medium">Ended</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {page.items.map((scan) => (
              <tr key={scan.id}>
                <td className="px-4 py-3">
                  <Badge variant="muted">{scan.status}</Badge>
                </td>
                <td className="px-4 py-3">{scan.mode}</td>
                <td className="px-4 py-3">{scan.workspace.name}</td>
                <td className="px-4 py-3">{scan.target?.name ?? "Deleted target"}</td>
                <td className="px-4 py-3">
                  <time dateTime={scan.createdAt.toISOString()}>
                    {scan.createdAt.toLocaleString()}
                  </time>
                </td>
                <td className="px-4 py-3">
                  {scan.startedAt ? (
                    <time dateTime={scan.startedAt.toISOString()}>
                      {scan.startedAt.toLocaleString()}
                    </time>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-3">
                  {scan.endedAt ? (
                    <time dateTime={scan.endedAt.toISOString()}>
                      {scan.endedAt.toLocaleString()}
                    </time>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {page.items.length === 0 && <p className="text-muted-foreground text-sm">No scans found.</p>}
      {page.nextCursor && (
        <Link
          href={`/dashboard/admin/scans?cursor=${encodeURIComponent(page.nextCursor)}`}
          className={buttonVariants({ variant: "secondary", className: "self-start" })}
        >
          Next page
        </Link>
      )}
    </div>
  )
}
