import {
  MYRA_LIMITS,
  type MyraClient,
  type MyraClientError,
  type MyraStreamEvent,
} from "@lyrashield/myra"
import {
  add,
  el,
  renderMyraComponent,
  renderMyraMarkdownBody,
  renderMyraProposalActions,
  type MyraDomRendererContext,
} from "./myra-dom-renderer"
import { clearMyraToken } from "./myra-session"

interface Turn {
  id: number
  root: HTMLElement
  answerEl: HTMLElement | null
  answerBuf: string
  completedAction: boolean
  stopped: boolean
}

export interface MyraConversation {
  send: (text: string) => Promise<void>
  stopStream: () => void
  stopAndMark: () => void
  markActionCompleted: () => void
  setLastTraceId: (traceId: string) => void
  getLastTraceId: () => string | undefined
}

export function createMyraConversation(options: {
  client: MyraClient
  bootstrapSession: () => Promise<void>
  rendererContext: MyraDomRendererContext
  logEl: HTMLElement
  emptyEl: HTMLElement | null
  inputEl: HTMLTextAreaElement
  beforeSend: () => void
  setStreaming: (on: boolean) => void
  setActivity: (label: string | null) => void
  announce: (text: string) => void
  nearBottom: () => boolean
  scrollToBottom: () => void
}): MyraConversation {
  const {
    client,
    bootstrapSession,
    rendererContext,
    logEl,
    emptyEl,
    inputEl,
    beforeSend,
    setStreaming,
    setActivity,
    announce,
    nearBottom,
    scrollToBottom,
  } = options

  let conversationId: string | undefined
  let lastTraceId: string | undefined
  let turnSeq = 0
  let currentTurn: Turn | null = null
  let streamAbort: AbortController | null = null

  function addTurn(userText: string): Turn {
    emptyEl?.setAttribute("hidden", "")
    const turn: Turn = {
      id: ++turnSeq,
      root: el("div", "myra-turn"),
      answerEl: null,
      answerBuf: "",
      completedAction: false,
      stopped: false,
    }
    const userBubble = el("div", "myra-msg myra-msg-user")
    add(userBubble, el("p", "myra-p", userText))
    const assistant = el("div", "myra-msg myra-msg-assistant")
    const answer = el("div", "myra-answer")
    add(assistant, answer)
    turn.answerEl = answer
    add(turn.root, userBubble, assistant)
    add(logEl, turn.root)
    return turn
  }

  function markStopped(turn: Turn) {
    turn.stopped = true
    if (turn.root.dataset.stopped) return
    turn.root.dataset.stopped = "1"
    add(
      turn.root,
      el(
        "p",
        "myra-note",
        turn.completedAction
          ? "Stopped. Actions that already completed were not undone."
          : "Stopped — nothing was executed."
      )
    )
  }

  function markError(turn: Turn, code?: string, recoveredDraft = false) {
    add(
      turn.root,
      el(
        "p",
        "myra-note myra-note-error",
        code === "PROPOSAL_EXPIRED"
          ? "That request expired — ask Myra to prepare it again."
          : recoveredDraft
            ? "Something went wrong before Myra replied. Your message is back in the composer."
            : "Something went wrong. Try again or talk to a person."
      )
    )
  }

  function refreshAnswer(turn: Turn) {
    if (turn.answerEl) renderMyraMarkdownBody(turn.answerEl, turn.answerBuf)
  }

  function handleEvent(ev: MyraStreamEvent, turn: Turn) {
    switch (ev.type) {
      case "ready":
        conversationId = ev.conversationId
        lastTraceId = ev.traceId
        return
      case "activity":
        setActivity(ev.label)
        return
      case "token":
        turn.answerBuf += ev.text
        if (turn.answerEl && nearBottom()) {
          refreshAnswer(turn)
          scrollToBottom()
        } else {
          refreshAnswer(turn)
        }
        return
      case "component": {
        const host = turn.answerEl?.parentElement ?? turn.root
        renderMyraComponent(ev.component, host, rendererContext)
        scrollToBottom()
        return
      }
      case "proposal": {
        if (turn.root.querySelector(`[data-proposal-id="${CSS.escape(ev.proposal.id)}"]`)) {
          announce("Myra prepared an action for you to confirm.")
          return
        }
        const card = el("section", "myra-card myra-card-confirm")
        add(card, el("p", "myra-card-title", ev.proposal.title))
        add(card, el("p", "myra-p", ev.proposal.description))
        const previewEntries = Object.entries(ev.proposal.payloadPreview ?? {}).slice(0, 8)
        if (previewEntries.length) {
          const dl = el("dl", "myra-kv")
          for (const [k, v] of previewEntries) {
            add(dl, el("dt", "", k))
            add(dl, el("dd", "", typeof v === "string" ? v : JSON.stringify(v)))
          }
          add(card, dl)
        }
        add(card, el("p", "myra-meta", `Expires ${ev.proposal.expiresAt}`))
        renderMyraProposalActions(
          card,
          {
            id: ev.proposal.id,
            title: ev.proposal.title,
            description: ev.proposal.description,
            confirmLabel: "Confirm",
            expiresAt: ev.proposal.expiresAt,
          },
          rendererContext
        )
        add(turn.answerEl?.parentElement ?? turn.root, card)
        scrollToBottom()
        announce("Myra prepared an action for you to confirm.")
        return
      }
      case "operation": {
        const selector = `[data-proposal-id="${CSS.escape(ev.operationId)}"]`
        const card = turn.root.querySelector<HTMLElement>(selector)
        if (card) {
          let state = card.querySelector<HTMLElement>(".myra-note")
          if (!state) {
            state = el("p", "myra-note")
            add(card, state)
          }
          state.hidden = false
          state.textContent = `Status: ${ev.status.toLowerCase().replace(/_/g, " ")}`
          if (ev.status === "COMPLETED") turn.completedAction = true
        }
        return
      }
      case "done":
        setActivity(null)
        if (lastTraceId) {
          const host = turn.answerEl?.parentElement ?? turn.root
          add(host, el("p", "myra-trace", `trace ${lastTraceId}`))
        }
        announce("Myra finished responding.")
        return
      case "error":
        setActivity(null)
        markError(turn, ev.error.code)
        announce(`Error: ${ev.error.message}`)
        return
      default:
        return
    }
  }

  async function send(text: string) {
    const trimmed = text.trim().slice(0, MYRA_LIMITS.messageMaxChars)
    if (!trimmed) return
    if (streamAbort) {
      announce("Myra is still answering — wait a moment or press Stop.")
      inputEl.value = trimmed
      return
    }
    beforeSend()
    inputEl.value = ""
    const turn = addTurn(trimmed)
    currentTurn = turn
    scrollToBottom()
    setStreaming(true)
    setActivity("Working on it…")
    announce("Message sent.")
    streamAbort = new AbortController()

    let attemptedReauth = false
    let received = false
    for (;;) {
      try {
        await bootstrapSession()
        for await (const ev of client.sendMessage({
          text: trimmed,
          conversationId,
          signal: streamAbort.signal,
        })) {
          received = true
          handleEvent(ev, turn)
        }
        break
      } catch (err) {
        if (streamAbort.signal.aborted || (err as Error).name === "AbortError") break
        const code = (err as MyraClientError).code
        if (code === "UNAUTHORIZED" && !attemptedReauth) {
          attemptedReauth = true
          clearMyraToken()
          continue
        }
        setActivity(null)
        const recoveredDraft = !received && !inputEl.value
        if (recoveredDraft) inputEl.value = trimmed
        markError(turn, code, recoveredDraft)
        announce("Message failed.")
        break
      }
    }

    streamAbort = null
    setStreaming(false)
    setActivity(null)
    if (turn.stopped) markStopped(turn)
  }

  function stopStream() {
    if (!streamAbort) return
    streamAbort.abort()
    streamAbort = null
  }

  function stopAndMark() {
    if (!streamAbort) return
    if (currentTurn) currentTurn.stopped = true
    stopStream()
    setStreaming(false)
    setActivity(null)
    if (currentTurn) markStopped(currentTurn)
    announce("Stopped — generation canceled. Anything already confirmed was not undone.")
  }

  return {
    send,
    stopStream,
    stopAndMark,
    markActionCompleted: () => {
      if (currentTurn) currentTurn.completedAction = true
    },
    setLastTraceId: (traceId) => {
      lastTraceId = traceId
    },
    getLastTraceId: () => lastTraceId,
  }
}
