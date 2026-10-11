import { NotificationPreferences } from "../../apps/web/src/components/notification-preferences"

export function NotificationPreferencesHarness() {
  const params = new URLSearchParams(location.search)
  document.documentElement.classList.toggle("dark", params.get("theme") === "dark")
  return (
    <main className="mx-auto min-h-screen w-full min-w-0 max-w-3xl space-y-6 px-4 py-6">
      <h1 className="text-2xl font-semibold">Notifications</h1>
      <NotificationPreferences />
    </main>
  )
}
