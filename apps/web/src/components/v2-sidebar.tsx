"use client"

import { useState } from "react"
import Image from "next/image"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { authClient } from "@lyrashield/auth"
import { LogOut } from "lucide-react"
import { Button, cn } from "@lyrashield/ui"
import { WorkspaceSwitcher } from "./workspace-switcher"
import { ThemeToggle } from "./theme-toggle"
import { NAV_ITEMS } from "@/lib/nav-items"
import { apiPost } from "@/lib/api-client"

interface Workspace {
  id: string
  name: string
  slug: string
  mode: string
  plan: string
  role: string
}

export function V2Sidebar({
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

  return (
    <aside className="sticky top-0 hidden h-screen w-72 shrink-0 border-r md:block">
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
            <span className="text-muted-foreground block text-[10px] font-semibold tracking-[0.16em] uppercase">
              Evidence console
            </span>
          </div>
        </div>

        {workspaces.length > 0 && (
          <div className="shrink-0 border-b p-2.5">
            <WorkspaceSwitcher
              workspaces={workspaces}
              activeId={activeWorkspaceId}
              onSelect={handleSelectWorkspace}
            />
          </div>
        )}

        <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Main navigation">
          <div className="flex flex-col gap-1">
            {NAV_ITEMS.map((item) => {
              const isActive =
                item.href === "/dashboard"
                  ? pathname === item.href
                  : pathname === item.href || pathname.startsWith(`${item.href}/`)
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "group flex min-h-11 items-center gap-3 border-l-2 px-3 text-sm font-medium transition-[background-color,border-color,color] duration-150",
                    isActive
                      ? "border-primary bg-primary/8 text-primary"
                      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground border-transparent"
                  )}
                >
                  <item.icon
                    className={cn(
                      "size-4.5 shrink-0",
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
            onClick={handleSignOut}
            aria-label="Sign out"
            variant="ghost"
            className="text-sidebar-foreground hover:bg-sidebar-accent w-full justify-start gap-3 px-3"
          >
            <LogOut className="size-4" aria-hidden="true" />
            Sign out
          </Button>
        </div>
      </div>
    </aside>
  )
}
