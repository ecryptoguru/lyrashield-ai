import Link from "next/link"
import { buttonVariants } from "@lyrashield/ui"

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="text-center">
        <h1 className="text-6xl font-bold text-primary">404</h1>
        <p className="mt-4 text-lg text-muted-foreground">Page not found</p>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
        <Link
          href="/"
          className={`${buttonVariants({ size: "md" })} mt-6`}
        >
          Go home
        </Link>
      </div>
    </div>
  )
}
