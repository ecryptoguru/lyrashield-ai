import { ProposalActions } from "../../apps/web/src/components/myra/myra-presentation"
import { useMyraPanel } from "../../apps/web/src/components/myra/use-myra-panel"

export default function MyraHarness() {
  const panel = useMyraPanel(undefined)
  return (
    <main>
      <h1>Myra proposal</h1>
      <ProposalActions
        proposalId="proposal-1"
        confirmLabel="Confirm action"
        context={panel.componentContext}
      />
      <output data-testid="announcement">{panel.announcement}</output>
    </main>
  )
}
