"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { authClient } from "@lyrashield/auth"
import { useRouter } from "next/navigation"
import {
  ShieldCheck,
  Rocket,
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
  Bell,
  Calendar,
  Menu,
  X,
} from "lucide-react"
import { Button } from "@lyrashield/ui"
import { WorkspaceSwitcher } from "./workspace-switcher"
import { apiPost } from "@/lib/api-client"

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/dashboard/projects", label: "Projects", icon: FolderKanban },
  { href: "/dashboard/targets", label: "Targets", icon: Crosshair },
  { href: "/dashboard/scans", label: "Scans", icon: Radar },
  { href: "/dashboard/findings", label: "Findings", icon: Bug },
  { href: "/dashboard/fixes", label: "Fixes", icon: Wrench },
  { href: "/dashboard/reports", label: "Reports", icon: FileText },
  { href: "/dashboard/launch-readiness", label: "Launch Readiness", icon: Rocket },
  { href: "/dashboard/notifications", label: "Notifications", icon: Bell },
  { href: "/dashboard/schedules", label: "Schedules", icon: Calendar },
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
  activeWorkspaceId: initialWorkspaceId,
}: {
  userName: string
  userEmail: string
  workspaces: Workspace[]
  activeWorkspaceId: string | null
}) {
  const pathname = usePathname()
  const router = useRouter()
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(initialWorkspaceId)
  const [mobileOpen, setMobileOpen] = useState(false)

  async function handleSelectWorkspace(id: string) {
    try {
      await apiPost("/api/workspaces/active", { workspaceId: id })
      setActiveWorkspaceId(id)
      router.refresh()
    } catch {
      // Keep the last server-confirmed workspace selected if persistence fails.
    }
  }

  async function handleSignOut() {
    await authClient.signOut()
    router.push("/sign-in")
    router.refresh()
  }

  const sidebarContent = (
    <>
      <div className="flex h-16 items-center gap-2.5 border-b px-5">
        <div className="gradient-primary flex h-8 w-8 items-center justify-center rounded-lg">
          <ShieldCheck className="text-primary-foreground h-5 w-5" aria-hidden="true" />
        </div>
        <span className="text-lg font-bold tracking-tight">LyraShield</span>
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

      <nav className="flex-1 space-y-1 overflow-y-auto p-3" aria-label="Main navigation">
        {navItems.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(item.href + "/")
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? "page" : undefined}
              onClick={() => setMobileOpen(false)}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all ${
                isActive
                  ? "bg-primary/8 text-primary font-semibold"
                  : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              }`}
            >
              <item.icon
                className={`h-4 w-4 shrink-0 ${isActive ? "text-primary" : "text-muted-foreground"}`}
                aria-hidden="true"
              />
              {item.label}
            </Link>
          )
        })}
      </nav>

      <div className="border-t p-3">
        <div className="mb-2 flex items-center gap-3 rounded-lg px-3 py-2">
          <div className="bg-primary/10 text-primary flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
            {userName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{userName}</p>
            <p className="text-muted-foreground truncate text-xs">{userEmail}</p>
          </div>
        </div>
        <Button
          onClick={handleSignOut}
          aria-label="Sign out"
          variant="ghost"
          className="text-sidebar-foreground hover:bg-sidebar-accent w-full justify-start gap-3 px-3 py-2 text-sm font-medium"
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
          Sign out
        </Button>
      </div>
    </>
  )

  return (
    <>
      {!mobileOpen && (
        <button
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
          className="bg-card fixed top-4 left-4 z-30 rounded-lg border p-2 shadow-md md:hidden"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </button>
      )}

      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={`bg-sidebar fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r transition-transform duration-300 md:relative md:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <button
          onClick={() => setMobileOpen(false)}
          aria-label="Close menu"
          className="hover:bg-sidebar-accent absolute top-5 right-3 rounded-lg p-1 md:hidden"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
        {sidebarContent}
      </aside>
    </>
  )
}
