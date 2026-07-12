import { redirect } from "next/navigation"
import { env } from "@lyrashield/config"
import { getCachedSession } from "@/lib/cache"

export default async function RootPage() {
  const session = await getCachedSession()

  if (session) {
    redirect("/dashboard")
  }

  // If the marketing URL is not configured, the safest fallback is the
  // app's own sign-in page rather than a hardcoded localhost origin.
  redirect(env.NEXT_PUBLIC_MARKETING_URL || "/sign-in")
}
