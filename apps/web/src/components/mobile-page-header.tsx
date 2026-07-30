"use client"

import Image from "next/image"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Bell, ChevronLeft } from "lucide-react"
import { buttonVariants } from "@lyrashield/ui"
import { NAV_ITEMS } from "@/lib/nav-items"
import { useFeatureFlags } from "./feature-flags-provider"
import { ThemeToggle } from "./theme-toggle"

/**
 * Resolves the current destination's label from the shared nav definition, preferring the
 * longest matching href so "/dashboard/products" wins over "/dashboard".
 */
function usePageTitle(explicit?: string): string {
  const pathname = usePathname()
  if (explicit) return explicit
  const match = NAV_ITEMS.filter(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`)
  ).sort((a, b) => b.href.length - a.href.length)[0]
  return match?.label ?? "LyraShield AI"
}

export function MobilePageHeader({ title, backHref }: { title?: string; backHref?: string }) {
  const flags = useFeatureFlags()
  const pageTitle = usePageTitle(title)
  if (!flags.uxV2Shell) return null

  return (
    <header className="bg-background fixed top-0 z-30 flex h-[calc(4rem+env(safe-area-inset-top))] w-full items-center justify-between border-b px-4 pt-[env(safe-area-inset-top)] md:hidden">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {backHref ? (
          <Link
            href={backHref}
            className={`${buttonVariants({ variant: "ghost", size: "icon" })} text-muted-foreground hover:text-foreground`}
            aria-label="Back"
          >
            <ChevronLeft className="size-5" aria-hidden="true" />
          </Link>
        ) : (
          // The brand mark keeps the mobile shell recognisably the same product as the
          // desktop sidebar, without spending the title slot on the brand name.
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-[#07111f] p-1">
            <Image
              src="/icon.svg"
              alt=""
              width={28}
              height={28}
              className="size-5"
              aria-hidden="true"
            />
          </span>
        )}
        <h1 className="min-w-0 truncate text-lg font-semibold">{pageTitle}</h1>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <ThemeToggle
          tooltipSide="bottom"
          className="text-muted-foreground hover:text-foreground shrink-0"
        />
        <Link
          href="/dashboard/notifications"
          aria-label="Notifications"
          className={`${buttonVariants({ variant: "ghost", size: "icon" })} text-muted-foreground hover:text-foreground relative shrink-0`}
        >
          <Bell className="size-5" aria-hidden="true" />
        </Link>
      </div>
    </header>
  )
}
