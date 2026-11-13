"use client"

import { useRouter } from "next/navigation"
import { LogOut } from "lucide-react"
import { Button } from "@lyrashield/ui"
import { signOutAndClearSessionData } from "@/lib/sign-out"

export function SignOutButton() {
  const router = useRouter()

  async function handleSignOut() {
    const result = await signOutAndClearSessionData()
    if (result.error) return
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
