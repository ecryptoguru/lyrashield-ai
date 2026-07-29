"use client"

import Link from "next/link"
import { Bell } from "lucide-react"
import { Button } from "@lyrashield/ui"
import { useFeatureFlags } from "./feature-flags-provider"

export function MobilePageHeader({ title, backHref }: { title: string; backHref?: string }) {
  const flags = useFeatureFlags()
  if (!flags.uxV2Shell) return null

  return (
    <header className="bg-background fixed top-0 z-30 flex h-16 w-full items-center justify-between border-b px-4 md:hidden">
      <div className="flex items-center gap-2">
        {backHref ? (
          <Link href={backHref} className="text-muted-foreground hover:text-foreground">
            <span aria-hidden="true">←</span>
            <span className="sr-only">Back</span>
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
