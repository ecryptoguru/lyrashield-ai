import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { requirePlatformAdminIdentity } from "@lyrashield/auth/server"
import { PageHeader } from "@/components/page-header"
import { SupportInbox } from "./support-inbox-client"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Support Inbox",
}

/**
 * Founder/operator support inbox for Myra cases. Same boundary as the rest of
 * the admin console: allowlisted PLATFORM_OPERATOR session with recent TOTP.
 * Reads use the 12h identity window; mutations on the client require the
 * 30-minute elevation (enforced by the API routes).
 */
export default async function SupportInboxPage() {
  try {
    await requirePlatformAdminIdentity()
  } catch {
    notFound()
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Support inbox"
        description="Myra support cases across the platform. Case content is shown verbatim; taking over pauses Myra on that conversation."
      />
      <SupportInbox />
    </div>
  )
}
