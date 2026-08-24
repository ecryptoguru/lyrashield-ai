import Link from "next/link"
import { notFound } from "next/navigation"
import { requirePlatformAdminIdentity } from "@lyrashield/auth/server"
import { Badge, buttonVariants } from "@lyrashield/ui"
import { PageHeader } from "@/components/page-header"
import { getPlatformAdminUsers, parseAdminCursor } from "@/lib/platform-admin-lists"

export const dynamic = "force-dynamic"

export default async function PlatformAdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>
}) {
  const identity = await requirePlatformAdminIdentity().catch(() => notFound())

  const cursor = parseAdminCursor((await searchParams).cursor)
  const page = await getPlatformAdminUsers(identity, cursor)

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Users"
        description="Minimal account security state. Sessions, credentials, and customer content are excluded."
      />
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-3xl text-left text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Email</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Platform role</th>
              <th className="px-4 py-3 font-medium">MFA</th>
              <th className="px-4 py-3 font-medium">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {page.items.map((user) => (
              <tr key={user.id}>
                <td className="px-4 py-3">{user.email}</td>
                <td className="px-4 py-3">
                  <Badge variant={user.emailVerified ? "success" : "warning"}>
                    {user.emailVerified ? "Verified" : "Unverified"}
                  </Badge>
                </td>
                <td className="px-4 py-3">{user.platformRole ?? "User"}</td>
                <td className="px-4 py-3">{user.twoFactorEnabled ? "Enabled" : "Not enabled"}</td>
                <td className="px-4 py-3">
                  <time dateTime={user.createdAt.toISOString()}>
                    {user.createdAt.toLocaleDateString()}
                  </time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {page.items.length === 0 && <p className="text-muted-foreground text-sm">No users found.</p>}
      {page.nextCursor && (
        <Link
          href={`/dashboard/admin/users?cursor=${encodeURIComponent(page.nextCursor)}`}
          className={buttonVariants({ variant: "secondary", className: "self-start" })}
        >
          Next page
        </Link>
      )}
    </div>
  )
}
