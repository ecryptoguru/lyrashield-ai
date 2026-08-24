import Link from "next/link"
import { notFound } from "next/navigation"
import { requirePlatformAdminIdentity } from "@lyrashield/auth/server"
import { buttonVariants } from "@lyrashield/ui"
import { PageHeader } from "@/components/page-header"
import { getPlatformAdminAudit, parseAdminCursor } from "@/lib/platform-admin-lists"

export const dynamic = "force-dynamic"

export default async function PlatformAdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>
}) {
  const identity = await requirePlatformAdminIdentity().catch(() => notFound())

  const cursor = parseAdminCursor((await searchParams).cursor)
  const page = await getPlatformAdminAudit(identity, cursor)

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Admin audit"
        description="Completed platform mutations. Secrets and mutation inputs are never displayed."
      />
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-4xl text-left text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Action</th>
              <th className="px-4 py-3 font-medium">Resource</th>
              <th className="px-4 py-3 font-medium">Actor (current email)</th>
              <th className="px-4 py-3 font-medium">Time</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {page.items.map((entry) => (
              <tr key={entry.id}>
                <td className="px-4 py-3 font-medium">{entry.action}</td>
                <td className="px-4 py-3">
                  {entry.resourceType}
                  {entry.resourceId ? ` · ${entry.resourceId}` : ""}
                </td>
                <td className="max-w-72 px-4 py-3">
                  <span
                    className="block truncate"
                    aria-label={entry.actorEmail}
                    title={entry.actorEmail}
                  >
                    {entry.actorEmail}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <time dateTime={entry.createdAt.toISOString()}>
                    {entry.createdAt.toLocaleString()}
                  </time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {page.items.length === 0 && (
        <p className="text-muted-foreground text-sm">No completed admin mutations.</p>
      )}
      {page.nextCursor && (
        <Link
          href={`/dashboard/admin/audit?cursor=${encodeURIComponent(page.nextCursor)}`}
          className={buttonVariants({ variant: "secondary", className: "self-start" })}
        >
          Next page
        </Link>
      )}
    </div>
  )
}
