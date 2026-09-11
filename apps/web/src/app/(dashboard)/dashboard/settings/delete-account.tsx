"use client"

import { Mail } from "lucide-react"
import { Button } from "@lyrashield/ui"

// The address is assembled client-side so no literal `mailto:user@host`
// reaches the SSR HTML — CDN email obfuscation rewrites that markup and
// breaks React hydration on the settings page.
const SUPPORT_EMAIL = "support@lyrashieldai.com"

export function DeleteAccount() {
  return (
    <div className="border-destructive/40 space-y-4 border-t pt-6">
      <div>
        <h2 className="font-semibold">Delete account</h2>
        <p className="text-muted-foreground mt-1 max-w-2xl text-sm leading-6">
          Account deletion is reviewed before removal so billing, audit, security evidence, and
          workspace ownership records are handled safely. Email support from your account address to
          start the request.
        </p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          window.location.href = `mailto:${SUPPORT_EMAIL}?subject=LyraShield%20account%20deletion%20request`
        }}
      >
        <Mail className="h-4 w-4" aria-hidden="true" />
        Request account deletion
      </Button>
    </div>
  )
}
