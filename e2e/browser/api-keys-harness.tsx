import { ApiKeysSection } from "../../apps/web/src/app/(dashboard)/dashboard/settings/api-keys"
import { useState } from "react"

export default function ApiKeysHarness() {
  const [workspaceId, setWorkspaceId] = useState("fixture-workspace")
  return (
    <main className="mx-auto min-h-screen w-full max-w-4xl px-4 py-6">
      {new URLSearchParams(location.search).has("switch-workspace") && (
        <button
          type="button"
          onClick={() =>
            setWorkspaceId((current) =>
              current === "fixture-workspace" ? "other-workspace" : "fixture-workspace"
            )
          }
        >
          Switch workspace
        </button>
      )}
      <ApiKeysSection workspaceId={workspaceId} canManage />
    </main>
  )
}
