"use client"

import { useState } from "react"
import Image from "next/image"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { authClient } from "@lyrashield/auth"
import {
  Bug,
  Crosshair,
  FileText,
  LayoutDashboard,
  LogOut,
  Menu,
  Radar,
  Settings,
  Wrench,
} from "lucide-react"
import { Button, cn } from "@lyrashield/ui"
import { WorkspaceSwitcher } from "./workspace-switcher"
import { ThemeToggle } from "./theme-toggle"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { apiPost } from "@/lib/api-client"

const navItems = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/targets", label: "Targets", icon: Crosshair },
  { href: "/dashboard/scans", label: "Scans", icon: Radar },
  { href: "/dashboard/findings", label: "Findings", icon: Bug },
  { href: "/dashboard/fixes", label: "Fix proposals", icon: Wrench },
  { href: "/dashboard/reports", label: "Reports", icon: FileText },
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

interface SidebarPanelProps {
  pathname: string
  userName: string
  userEmail: string
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  onSelectWorkspace: (id: string) => Promise<void>
  onSignOut: () => Promise<void>
  onNavigate?: () => void
}

function SidebarPanel({
  pathname,
  userName,
  userEmail,
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onSignOut,
  onNavigate,
}: SidebarPanelProps) {
  return (
    <div className="bg-sidebar flex h-full min-h-0 flex-col">
      <div className="flex h-16 shrink-0 items-center gap-3 border-b px-5">
        <div className="shadow-primary-glow flex size-9 items-center justify-center rounded-xl border bg-[#07111f] p-1">
          <Image
            src="/icon.svg"
            alt=""
            width={32}
            height={32}
            className="size-6"
            aria-hidden="true"
          />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="block text-[15px] font-bold tracking-tight">LyraShield AI</span>
            <span className="border-primary/50 bg-primary/10 text-primary rounded border px-1 py-0.5 text-[9px] font-semibold tracking-[0.12em] uppercase">
              Beta
            </span>
          </div>
        </div>
      </div>

      {workspaces.length > 0 && (
        <div className="shrink-0 border-b p-2.5">
          <WorkspaceSwitcher
            workspaces={workspaces}
            activeId={activeWorkspaceId}
            onSelect={onSelectWorkspace}
          />
        </div>
      )}

      <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Main navigation">
        <div className="flex flex-col gap-1">
          {navItems.map((item) => {
            const isActive =
              item.href === "/dashboard"
                ? pathname === item.href
                : pathname === item.href || pathname.startsWith(`${item.href}/`)
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                onClick={onNavigate}
                className={cn(
                  "group flex min-h-11 items-center gap-3 border-l-2 px-3 text-sm font-medium transition-[background-color,border-color,color] duration-150",
                  isActive
                    ? "border-primary bg-primary/8 text-primary"
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground border-transparent"
                )}
              >
                <item.icon
                  className={cn(
                    "size-[18px] shrink-0",
                    isActive
                      ? "text-primary"
                      : "text-muted-foreground group-hover:text-sidebar-accent-foreground"
                  )}
                  aria-hidden="true"
                />
                {item.label}
              </Link>
            )
          })}
        </div>
      </nav>

      <div className="shrink-0 border-t p-3">
        <div className="mb-1 flex items-center gap-3 rounded-lg px-2 py-2">
          <div className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-bold">
            {userName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{userName}</p>
            <p className="text-muted-foreground truncate text-xs">{userEmail}</p>
          </div>
          <ThemeToggle className="shrink-0" />
        </div>
        <Button
          type="button"
          onClick={onSignOut}
          aria-label="Sign out"
          variant="ghost"
          className="text-sidebar-foreground hover:bg-sidebar-accent w-full justify-start gap-3 px-3"
        >
          <LogOut className="size-4" aria-hidden="true" />
          Sign out
        </Button>
      </div>
    </div>
  )
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

  const panelProps = {
    pathname,
    userName,
    userEmail,
    workspaces,
    activeWorkspaceId,
    onSelectWorkspace: handleSelectWorkspace,
    onSignOut: handleSignOut,
  }

  return (
    <>
      <div className="bg-background fixed inset-x-0 top-0 z-30 flex h-16 items-center justify-between border-b px-4 md:hidden">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg border bg-[#07111f] p-0.5">
            <Image
              src="/icon.svg"
              alt=""
              width={28}
              height={28}
              className="size-6"
              aria-hidden="true"
            />
          </div>
          <span className="text-sm font-bold tracking-tight">LyraShield AI</span>
          <span className="border-primary/50 bg-primary/10 text-primary rounded border px-1 py-0.5 text-[9px] font-semibold tracking-[0.12em] uppercase">
            Beta
          </span>
        </div>
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" size="icon" aria-label="Open navigation menu">
              <Menu aria-hidden="true" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-[min(88vw,19rem)] gap-0 p-0">
            <SheetHeader className="sr-only">
              <SheetTitle>Navigation menu</SheetTitle>
              <SheetDescription>Navigate LyraShield AI and switch workspaces.</SheetDescription>
            </SheetHeader>
            <SidebarPanel {...panelProps} onNavigate={() => setMobileOpen(false)} />
          </SheetContent>
        </Sheet>
      </div>

      <aside className="sticky top-0 hidden h-screen w-72 shrink-0 border-r md:block">
        <SidebarPanel {...panelProps} />
      </aside>
    </>
  )
}
