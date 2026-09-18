import Image from "next/image"
import Link from "next/link"
import { buttonVariants, cn } from "@lyrashield/ui"

/**
 * Not-found boundary for the authenticated console.
 *
 * Dashboard routes stream: `(dashboard)/loading.tsx` flushes a 200 shell before
 * the page resolves, so `notFound()` here cannot change the response status.
 * The copy therefore states what happened ("not in evidence") without claiming
 * an HTTP status the server does not return — the root not-found keeps the 404
 * language for routes that really do answer 404.
 */
export default function DashboardNotFound() {
  return (
    <main
      id="main-content"
      className="flex min-h-[60vh] flex-col items-center justify-center px-4 py-16"
    >
      <div className="w-full max-w-110">
        <div className="bg-card/80 rounded-xl border p-8 shadow-sm backdrop-blur-[2px] sm:p-10">
          <div className="flex flex-col items-center text-center">
            <div className="shadow-primary-glow flex size-12 items-center justify-center rounded-xl border bg-(--surface-void-logo) p-1.5">
              <Image
                src="/icon.svg"
                alt=""
                width={32}
                height={32}
                className="size-7"
                aria-hidden="true"
                priority
              />
            </div>
            <p className="text-muted-foreground mt-5 text-[11px] font-semibold tracking-[0.16em] uppercase">
              Not in evidence
            </p>
            <h1 className="mt-3 text-2xl font-bold tracking-tight text-balance">
              This page isn&apos;t in evidence
            </h1>
            <p className="text-muted-foreground mt-3 max-w-[32ch] text-sm text-pretty">
              The path doesn&apos;t exist or isn&apos;t available in this workspace. Check the URL
              or return to the console.
            </p>
            <div className="mt-8 flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
              <Link
                href="/dashboard"
                className={cn(buttonVariants({ size: "md" }), "w-full sm:w-auto")}
              >
                Go to dashboard
              </Link>
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}
