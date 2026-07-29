import { redirect } from "next/navigation"
import { getCachedSession } from "@/lib/cache"

export default async function RootPage() {
  const session = await getCachedSession()

  if (session) {
    redirect("/dashboard")
  }

  redirect("/sign-in")
}
