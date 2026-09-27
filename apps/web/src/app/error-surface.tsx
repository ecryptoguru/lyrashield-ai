"use client"

import Link from "next/link"
import { Button, buttonVariants, cn } from "@lyrashield/ui"

export function ErrorSurface({ reset }: { reset: () => void }) {
  return (
    <main
      id="main-content"
      className="bg-background flex min-h-screen items-center justify-center px-4 py-16"
    >
      <section
        role="alert"
        aria-live="assertive"
        className="bg-card w-full max-w-xl space-y-5 rounded-xl border p-6 shadow-sm sm:p-10"
      >
        <div>
          <p className="text-muted-foreground text-xs font-semibold tracking-[0.14em] uppercase">
            LyraShield AI · Evidence console
          </p>
          <h1 className="mt-3 text-2xl font-bold tracking-tight">This page could not load</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Something went wrong while loading this page. Try again or return to your dashboard.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={reset}>
            Try again
          </Button>
          <Link href="/dashboard" className={cn(buttonVariants({ variant: "outline" }))}>
            Go to dashboard
          </Link>
        </div>
      </section>
    </main>
  )
}
