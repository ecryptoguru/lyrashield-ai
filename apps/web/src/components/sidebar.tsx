"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { authClient } from "@lyrashield/auth"
import { useRouter } from "next/navigation"
import {
  ShieldCheck,
  LayoutDashboard,
  FolderKanban,
  Crosshair,
  Bug,
  Wrench,
  FileText,
  Settings,
  LogOut,
  Users,
  Radar,
  Plug,
} from "lucide-react"
import { WorkspaceSwitcher } from "./workspace-switcher"

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/dashboard/projects", label: "Projects", icon: FolderKanban },
  { href: "/dashboard/targets", label: "Targets", icon: Crosshair },
  { href: "/dashboard/scans", label: "Scans", icon: Radar },
  { href: "/dashboard/findings", label: "Findings", icon: Bug },
  { href: "/dashboard/fixes", label: "Fixes", icon: Wrench },
  { href: "/dashboard/reports", label: "Reports", icon: FileText },
  { href: "/dashboard/team", label: "Team", icon: Users },
  { href: "/dashboard/integrations", label: "Integrations", icon: Plug },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
]

interface Workspace {
  id: string
  name: string
  slug: string
  mode: string
  plan: string
  role: string
}

export function Sidebar({
  userName,
  userEmail,
  workspaces,
}: {
  userName: string
  userEmail: string
  workspaces: Workspace[]
}) {
  const pathname = usePathname()
  const router = useRouter()
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(
    workspaces[0]?.id ?? null
  )

  useEffect(() => {
    const stored = localStorage.getItem("activeWorkspaceId")
    if (stored && workspaces.some((w) => w.id === stored)) {
      queueMicrotask(() => setActiveWorkspaceId(stored))
    }
  }, [workspaces])

  function handleSelectWorkspace(id: string) {
    setActiveWorkspaceId(id)
    localStorage.setItem("activeWorkspaceId", id)
    router.refresh()
  }

  async function handleSignOut() {
    await authClient.signOut()
    router.push("/sign-in")
    router.refresh()
  }

  return (
    <aside className="flex w-64 flex-col border-r bg-sidebar">
      <div className="flex h-16 items-center gap-2 border-b px-4">
        <ShieldCheck className="h-6 w-6 text-primary" />
        <span className="text-lg font-bold">LyraShield</span>
      </div>

      {workspaces.length > 0 && (
        <div className="border-b p-2">
          <WorkspaceSwitcher
            workspaces={workspaces}
            activeId={activeWorkspaceId}
            onSelect={handleSelectWorkspace}
          />
        </div>
      )}

      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {navItems.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(item.href + "/")
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent/50"
              }`}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          )
        })}
      </nav>

      <div className="border-t p-3">
        <div className="mb-2 px-3">
          <p className="text-sm font-medium">{userName}</p>
          <p className="truncate text-xs text-muted-foreground">{userEmail}</p>
        </div>
        <button
          onClick={handleSignOut}
          aria-label="Sign out"
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground hover:bg-sidebar-accent/50"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </div>
    </aside>
  )
}
