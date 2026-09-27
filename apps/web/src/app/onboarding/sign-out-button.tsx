"use client"

import { useRouter } from "next/navigation"
import { LogOut } from "lucide-react"
import { authClient } from "@lyrashield/auth"
import { Button } from "@lyrashield/ui"
import { invalidateAnalyticsPreference } from "@/lib/analytics"

export function SignOutButton() {
  const router = useRouter()

  async function handleSignOut() {
    const result = await authClient.signOut()
    if (result.error) return
    invalidateAnalyticsPreference()
    router.push("/sign-in")
    router.refresh()
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => void handleSignOut()}
      className="text-muted-foreground hover:text-foreground absolute top-4 left-4 z-10"
    >
      <LogOut className="mr-2 size-4" aria-hidden="true" />
      Sign out
    </Button>
  )
}
