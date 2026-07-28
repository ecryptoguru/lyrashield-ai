"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn, Button } from "@lyrashield/ui"
import { PRIMARY_NAV_ITEMS, MORE_NAV_ITEMS, type NavItem } from "@/lib/nav-items"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Menu } from "lucide-react"
import { useState } from "react"
import { useFeatureFlags } from "./feature-flags-provider"

function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") {
    return pathname === href
  }
  return pathname === href || pathname.startsWith(`${href}/`)
}

function NavLink({ item, pathname, onClick }: { item: NavItem; pathname: string; onClick?: () => void }) {
  const active = isActive(pathname, item.href)
  return (
    <Link
      href={item.href}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-full w-full flex-col items-center justify-center gap-1 px-1 py-2 text-[10px] font-medium transition-colors",
        active ? "text-primary" : "text-muted-foreground hover:text-foreground"
      )}
    >
      <item.icon className="size-5 shrink-0" aria-hidden="true" />
      <span className="truncate">{item.shortLabel}</span>
    </Link>
  )
}

export function BottomNav({ unreadNotifications = 0 }: { unreadNotifications?: number }) {
  const flags = useFeatureFlags()
  const pathname = usePathname()
  const [moreOpen, setMoreOpen] = useState(false)

  if (!flags.uxV2Shell) return null

  return (
    <nav
      aria-label="Main navigation"
      className="bg-background fixed right-0 bottom-0 left-0 z-40 flex h-[calc(4rem+env(safe-area-inset-bottom))] items-center border-t pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <div className="grid h-16 w-full grid-cols-5 items-center">
        {PRIMARY_NAV_ITEMS.slice(0, 4).map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} />
        ))}
        <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="More navigation"
              className="flex h-full w-full flex-col items-center justify-center gap-1 rounded-none text-[10px] font-medium text-muted-foreground"
            >
              <Menu className="size-5" aria-hidden="true" />
              <span>More</span>
            </Button>
          </SheetTrigger>
          <SheetContent side="bottom" className="h-auto rounded-t-2xl pb-[env(safe-area-inset-bottom)]">
            <SheetHeader className="sr-only">
              <SheetTitle>More</SheetTitle>
              <SheetDescription>Additional navigation and settings.</SheetDescription>
            </SheetHeader>
            <div className="grid grid-cols-3 gap-2 py-4">
              {MORE_NAV_ITEMS.map((item) => (
                <NavLink key={item.href} item={item} pathname={pathname} onClick={() => setMoreOpen(false)} />
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
