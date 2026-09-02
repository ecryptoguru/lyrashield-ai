"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Image from "next/image"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { authClient } from "@lyrashield/auth"
import { LogOut } from "lucide-react"
import { Button, cn } from "@lyrashield/ui"
import { WorkspaceSwitcher } from "./workspace-switcher"
import { ThemeToggle } from "./theme-toggle"
import { PRIMARY_NAV_ITEMS, resolveNav, type NavItem } from "@/lib/nav-items"
import { apiPost } from "@/lib/api-client"
import { Badge } from "@lyrashield/ui"
interface Workspace {
  id: string
  name: string
  slug: string
  mode: string
  plan: string
  role: string
}

function SidebarLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const isActive =
    item.href === "/dashboard"
      ? pathname === item.href
      : pathname === item.href || pathname.startsWith(`${item.href}/`)
  return (
    <Link
      href={item.href}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "group flex min-h-11 items-center gap-3 border-l-2 px-3 text-sm font-medium transition-[background-color,border-color,color] duration-(--duration-fast) ease-out",
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
      <span className="flex-1 truncate">{item.label}</span>
      {item.badgeCount ? (
        <Badge variant="danger" className="ml-2 shrink-0">
          {item.badgeCount}
        </Badge>
      ) : null}
    </Link>
  )
}

export function V2Sidebar({
  userName,
  userEmail,
  workspaces,
  activeWorkspaceId: initialWorkspaceId,
  pendingApprovals = 0,
  canViewEvidenceVault = false,
  canManageBilling = false,
  platformAdminHref = null,
}: {
  userName: string
  userEmail: string
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  pendingApprovals?: number
  canViewEvidenceVault?: boolean
  canManageBilling?: boolean
  platformAdminHref?: string | null
}) {
  const pathname = usePathname()
  const router = useRouter()
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(initialWorkspaceId)
  // Scroll affordance: shown while the navigation region has more content
  // below the fold (e.g. Settings on short laptops), so truncation is never
  // silent. Cleared once the user scrolls to the bottom.
  const [navOverflowing, setNavOverflowing] = useState(false)
  const navRef = useRef<HTMLElement | null>(null)
  const { secondary } = resolveNav({
    pendingApprovals,
    canViewEvidenceVault,
    canManageBilling,
    platformAdminHref,
  })

  const measureNavOverflow = useCallback((el: HTMLElement | null) => {
    if (!el) return
    setNavOverflowing(el.scrollTop + el.clientHeight < el.scrollHeight - 4)
  }, [])

  useEffect(() => {
    const el = navRef.current
    if (!el) return
    measureNavOverflow(el)
    const observer = new ResizeObserver(() => measureNavOverflow(el))
    observer.observe(el)
    return () => observer.disconnect()
  }, [measureNavOverflow, secondary.length])

  async function handleSelectWorkspace(id: string) {
    try {
      await apiPost("/api/workspaces/active", { workspaceId: id })
      setActiveWorkspaceId(id)
      // A document navigation clears all workspace-bound client state and caches.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/dashboard")
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
        <a
          href="https://lyrashieldai.com"
          aria-label="Go to the LyraShield AI landing page"
          className="focus-visible:ring-ring flex h-14 shrink-0 items-center gap-3 border-b px-5 transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset"
        >
          <div className="shadow-primary-glow bg-card flex size-9 items-center justify-center rounded-xl border p-1">
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
                Open beta
              </span>
            </div>
            <span className="text-muted-foreground block text-[10px] font-semibold tracking-[0.16em] uppercase">
              Evidence console
            </span>
          </div>
        </a>

        {workspaces.length > 0 && (
          <div className="shrink-0 border-b p-2">
            <WorkspaceSwitcher
              workspaces={workspaces}
              activeId={activeWorkspaceId}
              onSelect={handleSelectWorkspace}
            />
          </div>
        )}

        <div className="relative min-h-0 flex-1">
          <nav
            ref={navRef}
            className="h-full overflow-y-auto px-3 py-3"
            aria-label="Main navigation"
            onScroll={(event) => measureNavOverflow(event.currentTarget)}
          >
            {/* Grouped rather than eleven flat peers. The nav model already encodes the split,
                so the sidebar reflects it instead of flattening product work and account
                settings into one undifferentiated list. */}
            <div className="flex flex-col">
              {PRIMARY_NAV_ITEMS.map((item) => (
                <SidebarLink key={item.href} item={item} pathname={pathname} />
              ))}
            </div>
            <div className="mt-3">
              <p className="text-muted-foreground px-3 pb-1.5 text-[10px] font-semibold tracking-[0.14em] uppercase">
                Workspace
              </p>
              <div className="flex flex-col">
                {secondary.map((item) => (
                  <SidebarLink key={item.href} item={item} pathname={pathname} />
                ))}
              </div>
            </div>
          </nav>
          {/* Overflow affordance: a soft fade over the last rows while more
              destinations sit below the visible navigation region. */}
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-sidebar to-transparent transition-opacity duration-(--duration-fast)",
              navOverflowing ? "opacity-100" : "opacity-0"
            )}
          />
        </div>

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
