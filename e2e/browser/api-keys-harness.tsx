import { ApiKeysSection } from "../../apps/web/src/app/(dashboard)/dashboard/settings/api-keys"

export default function ApiKeysHarness() {
  return (
    <main className="mx-auto min-h-screen w-full max-w-4xl px-4 py-6">
      <ApiKeysSection workspaceId="fixture-workspace" canManage />
    </main>
  )
}
