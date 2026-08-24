import Link from "next/link"
import { notFound } from "next/navigation"
import { requirePlatformAdminIdentity } from "@lyrashield/auth/server"
import { Badge, buttonVariants } from "@lyrashield/ui"
import { PageHeader } from "@/components/page-header"
import { getPlatformAdminWorkspaces, parseAdminCursor } from "@/lib/platform-admin-lists"

export const dynamic = "force-dynamic"

export default async function PlatformAdminWorkspacesPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>
}) {
  try {
    await requirePlatformAdminIdentity()
  } catch {
    notFound()
  }

  const cursor = parseAdminCursor((await searchParams).cursor)
  const page = await getPlatformAdminWorkspaces(cursor)

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Workspaces"
        description="Tenant inventory with aggregate membership and target counts only."
      />
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-3xl text-left text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Workspace</th>
              <th className="px-4 py-3 font-medium">Plan</th>
              <th className="px-4 py-3 font-medium">Members</th>
              <th className="px-4 py-3 font-medium">Targets</th>
              <th className="px-4 py-3 font-medium">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {page.items.map((workspace) => (
              <tr key={workspace.id}>
                <td className="px-4 py-3">{workspace.name}</td>
                <td className="px-4 py-3">
                  <Badge variant="muted">{workspace.plan}</Badge>
                </td>
                <td className="px-4 py-3 tabular-nums">{workspace.memberCount}</td>
                <td className="px-4 py-3 tabular-nums">{workspace.targetCount}</td>
                <td className="px-4 py-3">
                  <time dateTime={workspace.createdAt.toISOString()}>
                    {workspace.createdAt.toLocaleDateString()}
                  </time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {page.items.length === 0 && (
        <p className="text-muted-foreground text-sm">No workspaces found.</p>
      )}
      {page.nextCursor && (
        <Link
          href={`/dashboard/admin/workspaces?cursor=${encodeURIComponent(page.nextCursor)}`}
          className={buttonVariants({ variant: "secondary", className: "self-start" })}
        >
          Next page
        </Link>
      )}
    </div>
  )
}
