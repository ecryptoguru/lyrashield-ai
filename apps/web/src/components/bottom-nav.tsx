"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn, Button, Badge } from "@lyrashield/ui"
import { resolveNav, type NavItem } from "@/lib/nav-items"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { ChevronRight, Menu } from "lucide-react"
import { useState } from "react"

function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") {
    return pathname === href
  }
  return pathname === href || pathname.startsWith(`${href}/`)
}

function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = isActive(pathname, item.href)
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex h-full w-full flex-col items-center justify-center gap-1 px-1 py-2 text-[10px] font-medium transition-colors duration-(--duration-fast) ease-out",
        "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset",
        "active:scale-[0.97] active:transition-transform active:duration-(--duration-instant)",
        active ? "text-primary" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {/* Active indicator — status must not be communicated by colour alone. */}
      <span
        aria-hidden="true"
        className={cn(
          "bg-primary absolute top-0 h-0.5 w-8 rounded-full transition-opacity duration-(--duration-fast) ease-out",
          active ? "opacity-100" : "opacity-0"
        )}
      />
      <item.icon className="size-5 shrink-0" aria-hidden="true" />
      <span className="truncate">{item.shortLabel}</span>
    </Link>
  )
}

function MoreNavRow({
  item,
  pathname,
  onNavigate,
  unreadNotifications,
}: {
  item: NavItem
  pathname: string
  onNavigate: () => void
  unreadNotifications: number
}) {
  const active = isActive(pathname, item.href)
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors duration-(--duration-fast) ease-out",
        "focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
        active ? "bg-primary/8 text-primary" : "text-foreground hover:bg-muted"
      )}
    >
      <item.icon
        className={cn("size-4.5 shrink-0", active ? "text-primary" : "text-muted-foreground")}
        aria-hidden="true"
      />
      <span className="flex-1 truncate">{item.label}</span>
      {item.badgeCount ? (
        <Badge variant="danger" className="mr-1 ml-2 shrink-0">
          {item.badgeCount}
        </Badge>
      ) : null}
      {item.href === "/dashboard/notifications" && unreadNotifications > 0 ? (
        <Badge variant="danger" className="mr-1 ml-2 shrink-0">
          {unreadNotifications}
        </Badge>
      ) : null}
      <ChevronRight className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
    </Link>
  )
}

export function BottomNav({
  unreadNotifications = 0,
  pendingApprovals = 0,
}: {
  unreadNotifications?: number
  pendingApprovals?: number
}) {
  const pathname = usePathname()
  const [moreOpen, setMoreOpen] = useState(false)
  const { mobilePrimary, more } = resolveNav({ pendingApprovals })

  return (
    <nav
      aria-label="Main navigation"
      className="bg-background fixed right-0 bottom-0 left-0 z-40 flex h-[calc(4rem+env(safe-area-inset-bottom))] items-center border-t pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <div className="grid h-16 w-full grid-cols-5 items-center">
        {mobilePrimary.map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} />
        ))}
        <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
          <SheetTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Workspace navigation"
              className="text-muted-foreground focus-visible:ring-ring relative flex h-full w-full flex-col items-center justify-center gap-1 rounded-none text-[10px] font-medium focus-visible:ring-2 focus-visible:ring-inset"
            >
              <Menu className="size-5" aria-hidden="true" />
              <span>Workspace</span>
              {unreadNotifications > 0 || pendingApprovals > 0 ? (
                <span
                  className="bg-destructive absolute top-2 right-4 size-2 rounded-full"
                  aria-hidden="true"
                />
              ) : null}
            </Button>
          </SheetTrigger>
          <SheetContent
            side="bottom"
            className="max-h-[80vh] overflow-y-auto rounded-t-2xl pb-[env(safe-area-inset-bottom)]"
          >
            <SheetHeader className="px-1 text-left">
              <SheetTitle className="text-base">Workspace</SheetTitle>
              <SheetDescription className="sr-only">
                Additional workspace navigation and settings.
              </SheetDescription>
            </SheetHeader>
            {/* A single-column list rather than a grid: the list is the exact complement of
                the bottom bar, so it grows as destinations are added and a grid leaves a
                ragged final row. */}
            <div className="flex flex-col gap-0.5 py-2">
              {more.map((item) => (
                <MoreNavRow
                  key={item.href}
                  item={item}
                  pathname={pathname}
                  onNavigate={() => setMoreOpen(false)}
                  unreadNotifications={unreadNotifications}
                />
              ))}
            </div>
          </SheetContent>
        </Sheet>
      </div>
      <div className="sr-only" aria-live="polite">
        {unreadNotifications > 0 ? `${unreadNotifications} unread notifications` : undefined}
      </div>
    </nav>
  )
}
