import { Mail } from "lucide-react"
import { buttonVariants } from "@lyrashield/ui"

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
      <a
        href={`mailto:${SUPPORT_EMAIL}?subject=LyraShield%20account%20deletion%20request`}
        className={buttonVariants({ variant: "secondary", size: "sm" })}
      >
        <Mail className="h-4 w-4" aria-hidden="true" />
        Request account deletion
      </a>
    </div>
  )
}
