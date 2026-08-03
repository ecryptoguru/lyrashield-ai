import { redirect } from "next/navigation"

export default function AgentsPage() {
  redirect("/dashboard/integrations?tab=agents")
}
