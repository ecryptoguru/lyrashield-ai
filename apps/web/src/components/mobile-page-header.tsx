"use client"

import Link from "next/link"
import { Bell, ChevronLeft } from "lucide-react"
import { Button, buttonVariants } from "@lyrashield/ui"
import { useFeatureFlags } from "./feature-flags-provider"

export function MobilePageHeader({ title, backHref }: { title: string; backHref?: string }) {
  const flags = useFeatureFlags()
  if (!flags.uxV2Shell) return null

  return (
    <header className="bg-background fixed top-0 z-30 flex h-[calc(4rem+env(safe-area-inset-top))] w-full items-center justify-between border-b pt-[env(safe-area-inset-top)] px-4 md:hidden">
      <div className="flex items-center gap-2">
        {backHref ? (
          <Link
            href={backHref}
            className={`${buttonVariants({ variant: "ghost", size: "icon" })} text-muted-foreground hover:text-foreground`}
            aria-label="Back"
          >
            <ChevronLeft className="size-5" aria-hidden="true" />
          </Link>
        ) : null}
        <h1 className="text-lg font-semibold">{title}</h1>
      </div>
      <Button variant="ghost" size="icon" aria-label="Notifications" className="relative">
        <Bell className="size-5" aria-hidden="true" />
      </Button>
    </header>
  )
}
