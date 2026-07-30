import Image from "next/image"
import Link from "next/link"
import { buttonVariants, cn } from "@lyrashield/ui"

export default function NotFound() {
  return (
    <div className="bg-background relative flex min-h-screen flex-col items-center justify-center px-4 py-16">
      {/* Subtle evidence console grid — low opacity so it reads as texture, not content. */}
      <div
        className="security-grid pointer-events-none absolute inset-0 opacity-[0.03]"
        aria-hidden="true"
      />
      <div className="relative w-full max-w-[440px]">
        <div className="bg-card/80 rounded-xl border p-8 shadow-sm backdrop-blur-[2px] sm:p-10">
          <div className="flex flex-col items-center text-center">
            <div className="shadow-primary-glow flex size-12 items-center justify-center rounded-xl border bg-[#07111f] p-1.5">
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
              404 · Not in evidence
            </p>
            <h1 className="mt-3 text-2xl font-bold tracking-tight text-balance">
              This page isn&apos;t in evidence
            </h1>
            <p className="text-muted-foreground mt-3 max-w-[32ch] text-sm text-pretty">
              The path doesn&apos;t exist or isn&apos;t available in this workspace. Check the URL
              or return to the console.
            </p>
            <div className="mt-8 flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
              <Link href="/" className={cn(buttonVariants({ size: "md" }), "w-full sm:w-auto")}>
                Go home
              </Link>
              <Link
                href="/dashboard"
                className={cn(
                  buttonVariants({ variant: "secondary", size: "md" }),
                  "w-full sm:w-auto"
                )}
              >
                Go to dashboard
              </Link>
            </div>
          </div>
        </div>
        <p className="text-muted-foreground mt-4 text-center text-[11px] tracking-wide">
          LyraShield AI · Evidence console
        </p>
      </div>
    </div>
  )
}
