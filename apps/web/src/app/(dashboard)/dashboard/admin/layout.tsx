import type { Metadata } from "next"
import { notFound } from "next/navigation"
import Link from "next/link"
import { requirePlatformAdminIdentity } from "@lyrashield/auth/server"

export const metadata: Metadata = {
  title: "Platform Admin | LyraShield AI",
  robots: { index: false, follow: false, noarchive: true, noimageindex: true },
  referrer: "no-referrer",
}

export default async function PlatformAdminLayout({ children }: { children: React.ReactNode }) {
  try {
    await requirePlatformAdminIdentity()
  } catch {
    notFound()
  }

  return (
    <div className="flex flex-col gap-5">
      <nav aria-label="Platform admin" className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
        <Link href="/dashboard/admin">Overview</Link>
        <Link href="/dashboard/admin/users">Users</Link>
        <Link href="/dashboard/admin/workspaces">Workspaces</Link>
        <Link href="/dashboard/admin/scans">Scans</Link>
        <Link href="/dashboard/admin/audit">Audit</Link>
        <Link href="/dashboard/admin/affiliates">Affiliates</Link>
      </nav>
      {children}
    </div>
  )
}
