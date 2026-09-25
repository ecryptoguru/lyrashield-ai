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
      <textarea
        aria-label="Myra message"
        value={panel.input}
        onChange={(event) => panel.onInputChange(event.target.value)}
      />
      <button type="button" onClick={() => void panel.send(panel.input)}>
        Send message
      </button>
      <button type="button" onClick={panel.stopStream}>
        Stop message
      </button>
      <output data-testid="streaming">{String(panel.streaming)}</output>
      <div role="log">
        {panel.turns.map((turn) => (
          <section key={turn.id}>
            <p>{turn.userText}</p>
            {turn.parts.map((part, index) =>
              part.kind === "answer" ? <p key={index}>{part.markdown}</p> : null
            )}
            {turn.error && <p role="alert">{turn.error}</p>}
            {turn.stopped && <p>Stopped</p>}
          </section>
        ))}
      </div>
    </main>
  )
}
