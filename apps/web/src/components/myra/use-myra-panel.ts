"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  createMyraClient,
  MYRA_LIMITS,
  type BookingRequest,
  type MyraClient,
  type MyraComponent,
  type MyraStreamEvent,
} from "@lyrashield/myra"
import { safeAppHref, type MyraComponentContext, type ProposalState } from "./myra-presentation"

// ─── Types ──────────────────────────────────────────────────────────────────

interface ProposalView {
  id: string
  title: string
  description: string
  confirmLabel: string
  expiresAt?: string
}

type Part =
  | { kind: "answer"; markdown: string }
  | { kind: "component"; component: MyraComponent }
  | { kind: "proposal"; proposal: ProposalView }

interface Turn {
  id: number
  userText: string
  parts: Part[]
  stopped?: boolean
  error?: string | null
  completedAction?: boolean
}

interface Suggestion {
  entryId: string
  title: string
  snippet: string
  sourceUrl?: string
}

export function useMyraPanel(
  routeContext: string | undefined,
  account?: { email?: string | null; name?: string | null }
) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [proposalStates, setProposalStates] = useState<
    Record<string, { state: ProposalState; statusText?: string }>
  >({})
  const [input, setInput] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [activity, setActivity] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState("")
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [suggestActive, setSuggestActive] = useState(-1)
  const [caseForm, setCaseForm] = useState<{
    subject: string
    summary: string
    includeDiagnostics: boolean
    includeTranscript: boolean
  } | null>(null)

  const turnsRef = useRef<Turn[]>([])
  useEffect(() => {
    turnsRef.current = turns
  }, [turns])
  const clientRef = useRef<MyraClient | null>(null)
  const conversationIdRef = useRef<string | undefined>(undefined)
  const lastTraceRef = useRef<string | undefined>(undefined)
  const turnSeq = useRef(0)
  const streamAbortRef = useRef<AbortController | null>(null)
  const suggestAbortRef = useRef<AbortController | null>(null)
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const logRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const stoppedTurnRef = useRef<number | null>(null)

  const getClient = useCallback((): MyraClient => {
    clientRef.current = createMyraClient({
      apiBase: "",
      surface: "DASHBOARD",
      routeContext,
    })
    return clientRef.current
  }, [routeContext])

  const announce = useCallback((text: string) => setAnnouncement(text), [])

  const scrollLogToEnd = useCallback(() => {
    const node = logRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [])

  const updateTurn = useCallback((id: number, fn: (t: Turn) => Turn) => {
    setTurns((prev) => prev.map((t) => (t.id === id ? fn(t) : t)))
  }, [])

  const handleEvent = useCallback(
    (ev: MyraStreamEvent, turnId: number) => {
      switch (ev.type) {
        case "ready":
          conversationIdRef.current = ev.conversationId
          lastTraceRef.current = ev.traceId
          return
        case "activity":
          setActivity(ev.label)
          return
        case "token":
          updateTurn(turnId, (t) => {
            const parts = [...t.parts]
            const last = parts[parts.length - 1]
            if (last && last.kind === "answer") {
              parts[parts.length - 1] = { kind: "answer", markdown: last.markdown + ev.text }
            } else {
              parts.push({ kind: "answer", markdown: ev.text })
            }
            return { ...t, parts }
          })
          return
        case "component":
          if (ev.component.type === "trace_ref") lastTraceRef.current = ev.component.traceId
          updateTurn(turnId, (t) => ({
            ...t,
            completedAction:
              t.completedAction ||
              (ev.component.type === "action_result" && ev.component.status === "COMPLETED"),
            parts: [...t.parts, { kind: "component", component: ev.component }],
          }))
          scrollLogToEnd()
          return
        case "proposal":
          updateTurn(turnId, (t) => {
            // The loop emits a structured confirm card AND this event for the
            // same proposal — skip the generic card when the rich card exists.
            const already = t.parts.some(
              (p) =>
                p.kind === "component" &&
                (p.component.type === "action_confirmation" ||
                  p.component.type === "support_case_preview") &&
                p.component.proposalId === ev.proposal.id
            )
            if (already) return t
            return {
              ...t,
              parts: [
                ...t.parts,
                {
                  kind: "proposal",
                  proposal: {
                    id: ev.proposal.id,
                    title: ev.proposal.title,
                    description: ev.proposal.description,
                    confirmLabel: "Confirm",
                    expiresAt: ev.proposal.expiresAt,
                  },
                },
              ],
            }
          })
          announce("Myra prepared an action for you to confirm.")
          scrollLogToEnd()
          return
        case "operation":
          setProposalStates((s) => ({
            ...s,
            [ev.operationId]: {
              ...(s[ev.operationId] ?? { state: "pending" }),
              statusText: `Status: ${ev.status.toLowerCase().replace(/_/g, " ")}`,
            },
          }))
          updateTurn(turnId, (t) => ({
            ...t,
            completedAction: t.completedAction || ev.status === "COMPLETED",
          }))
          return
        case "done":
          setActivity(null)
          if (lastTraceRef.current) {
            const traceId = lastTraceRef.current
            updateTurn(turnId, (t) => ({
              ...t,
              parts: [...t.parts, { kind: "component", component: { type: "trace_ref", traceId } }],
            }))
          }
          announce("Myra finished responding.")
          scrollLogToEnd()
          return
        case "error":
          setActivity(null)
          updateTurn(turnId, (t) => ({ ...t, error: ev.error.message }))
          announce(`Error: ${ev.error.message}`)
          return
      }
    },
    [announce, scrollLogToEnd, updateTurn]
  )

  const send = useCallback(
    async (rawText: string, bookingRequest?: BookingRequest) => {
      const text = rawText.trim().slice(0, MYRA_LIMITS.messageMaxChars)
      if (!text) return
      if (streamAbortRef.current) {
        // A turn is in flight — keep the draft, tell the user why.
        announce("Myra is still answering — wait a moment or press Stop.")
        return
      }
      setSuggestions([])
      setSuggestActive(-1)
      setInput("")
      const turnId = ++turnSeq.current
      setTurns((prev) => [...prev, { id: turnId, userText: text, parts: [] }])
      setStreaming(true)
      setActivity("Working on it…")
      announce("Message sent.")
      const abort = new AbortController()
      streamAbortRef.current = abort
      let received = false
      try {
        for await (const ev of getClient().sendMessage({
          text,
          conversationId: conversationIdRef.current,
          signal: abort.signal,
          bookingRequest,
        })) {
          received = true
          handleEvent(ev, turnId)
        }
      } catch (err) {
        if (abort.signal.aborted || (err as Error).name === "AbortError") {
          // Stopped by user — state was already marked in stopStream.
        } else {
          const code = (err as { code?: string }).code
          setActivity(null)
          if (!received) {
            // Send never reached the server — keep the draft rather than lose it.
            setInput(text)
          }
          updateTurn(turnId, (t) => ({
            ...t,
            error:
              code === "PROPOSAL_EXPIRED"
                ? "That request expired — ask Myra to prepare it again."
                : !received
                  ? "Something went wrong before Myra replied. Your message is back in the composer."
                  : "Something went wrong. Try again or talk to a person.",
          }))
          announce("Message failed.")
        }
      } finally {
        streamAbortRef.current = null
        setStreaming(false)
        setActivity(null)
      }
    },
    [announce, getClient, handleEvent, updateTurn]
  )

  const stopStream = useCallback(() => {
    if (!streamAbortRef.current) return
    streamAbortRef.current.abort()
    streamAbortRef.current = null
    setStreaming(false)
    setActivity(null)
    const id = turnSeq.current
    stoppedTurnRef.current = id
    updateTurn(id, (t) => ({ ...t, stopped: true }))
    announce("Stopped — generation canceled. Anything already confirmed was not undone.")
  }, [announce, updateTurn])

  const turnHoldingProposal = useCallback(
    (proposalId: string) =>
      turnsRef.current.find((t) =>
        t.parts.some(
          (p) =>
            (p.kind === "proposal" && p.proposal.id === proposalId) ||
            (p.kind === "component" &&
              (p.component.type === "action_confirmation" ||
                p.component.type === "support_case_preview" ||
                p.component.type === "action_result") &&
              p.component.proposalId === proposalId)
        )
      )?.id,
    []
  )

  const confirmProposalAction = useCallback(
    async (proposalId: string) => {
      const turnId = turnHoldingProposal(proposalId) ?? turnSeq.current
      const setProposal = (
        fn: (s: { state: ProposalState; statusText?: string }) => {
          state: ProposalState
          statusText?: string
        }
      ) =>
        setProposalStates((s) => ({
          ...s,
          [proposalId]: fn(s[proposalId] ?? { state: "pending" }),
        }))
      setProposal(() => ({ state: "working" }))
      try {
        const raw = (await getClient().confirmProposal(proposalId)) as {
          data?: { status?: string; result?: unknown; component?: MyraComponent }
        }
        const data = raw?.data ?? (raw as { status?: string; component?: MyraComponent })
        setProposal(() => ({
          state: "done",
          statusText: data?.status
            ? `Done — ${String(data.status).toLowerCase().replace(/_/g, " ")}.`
            : "Done.",
        }))
        if (data?.component) {
          updateTurn(turnId, (t) => ({
            ...t,
            completedAction: t.completedAction || data.status === "COMPLETED",
            parts: [...t.parts, { kind: "component", component: data.component! }],
          }))
        }
        announce("Action confirmed.")
      } catch (err) {
        const code = (err as { code?: string }).code
        setProposal(() => ({
          state: "pending",
          statusText:
            code === "PROPOSAL_EXPIRED"
              ? "That request expired — ask Myra to prepare it again."
              : code === "PROPOSAL_PAYLOAD_CHANGED"
                ? "The details changed — review the new summary before confirming."
                : code === "TAKEOVER_ACTIVE"
                  ? "A person is handling this conversation."
                  : "The action could not be completed. Try again or ask for a person.",
        }))
        announce("Action could not be confirmed.")
      }
    },
    [announce, getClient, turnHoldingProposal, updateTurn]
  )

  const cancelProposalAction = useCallback(
    async (proposalId: string) => {
      try {
        await getClient().cancelProposal(proposalId)
      } catch {
        /* cancellation failures still render the canceled state client-side */
      }
      setProposalStates((s) => ({ ...s, [proposalId]: { state: "cancelled" } }))
      announce("Action canceled.")
    },
    [announce, getClient]
  )

  // Debounced instant suggestions — retrieval only, never a model call.
  const onInputChange = useCallback(
    (value: string) => {
      setInput(value)
      clearTimeout(suggestTimerRef.current)
      const text = value.trim()
      if (text.length < 2) {
        setSuggestions([])
        setSuggestActive(-1)
        return
      }
      suggestTimerRef.current = setTimeout(() => {
        suggestAbortRef.current?.abort()
        suggestAbortRef.current = new AbortController()
        getClient()
          .suggest(text.slice(0, 300), suggestAbortRef.current.signal)
          .then((res) => {
            const payload =
              res && typeof res === "object" && "data" in res
                ? (res as { data: { suggestions?: Suggestion[] } }).data
                : (res as { suggestions?: Suggestion[] })
            setSuggestions((payload.suggestions ?? []).slice(0, 3))
            setSuggestActive(-1)
          })
          .catch(() => {
            /* suggestions are best-effort */
          })
      }, 150)
    },
    [getClient]
  )

  const pickSuggestion = useCallback(
    (s: Suggestion) => {
      setSuggestions([])
      setSuggestActive(-1)
      const turnId = ++turnSeq.current
      setTurns((prev) => [
        ...prev,
        {
          id: turnId,
          userText: s.title,
          parts: [
            { kind: "answer", markdown: s.snippet },
            ...(safeAppHref(s.sourceUrl)
              ? [
                  {
                    kind: "component" as const,
                    component: {
                      type: "source_link" as const,
                      label: "Source",
                      url: s.sourceUrl!,
                    },
                  },
                ]
              : []),
          ],
        },
      ])
      announce("Instant answer shown.")
    },
    [announce]
  )

  const submitCaseForm = useCallback(() => {
    if (!caseForm) return
    const subject = caseForm.subject.trim()
    const summary = caseForm.summary.trim()
    if (subject.length < 4 || summary.length < 10) {
      announce("Add a subject and a few words about what happened.")
      return
    }
    const parts = [
      "Please prepare a support case for me.",
      `Subject: ${subject}`,
      `Details: ${summary}`,
      `Include diagnostic excerpt: ${caseForm.includeDiagnostics ? "yes" : "no"}`,
      `Include transcript excerpt: ${caseForm.includeTranscript ? "yes" : "no"}`,
      ...(lastTraceRef.current ? [`Attach trace: ${lastTraceRef.current}`] : []),
    ]
    setCaseForm(null)
    void send(parts.join("\n"))
  }, [announce, caseForm, send])

  // Escape closes the suggestion list first, then the mobile sheet.
  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (suggestions.length) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault()
          setSuggestActive(
            (a) => (a + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length
          )
          return
        }
        if ((e.key === "Enter" || e.key === "Tab") && suggestActive >= 0) {
          e.preventDefault()
          const picked = suggestions[suggestActive]
          if (picked) pickSuggestion(picked)
          return
        }
        if (e.key === "Escape") {
          setSuggestions([])
          setSuggestActive(-1)
          return
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        // A turn is in flight — Enter must not fire a second send.
        if (streaming) return
        void send(input)
      }
    },
    [input, pickSuggestion, send, streaming, suggestActive, suggestions]
  )

  const componentContext: MyraComponentContext = {
    onBookSlot: (request) =>
      void send(`Book the demo slot that starts at ${request.slotStart}`, request),
    attendee: {
      email: account?.email ?? undefined,
      name: account?.name ?? undefined,
    },
    onConfirm: (proposalId) => void confirmProposalAction(proposalId),
    onCancel: (proposalId) => void cancelProposalAction(proposalId),
    onForgetMemory: () => {
      void getClient()
        .clearMemory()
        .then(() => {
          setTurns((previous) =>
            previous.map((turn) => ({
              ...turn,
              parts: turn.parts.map((part) =>
                part.kind === "component" && part.component.type === "memory_card"
                  ? { ...part, component: { ...part.component, entries: [] } }
                  : part
              ),
            }))
          )
          announce("Myra's saved support preferences were cleared.")
        })
        .catch(() => announce("Myra could not clear saved preferences. Try again."))
    },
    proposalStates,
  }

  return {
    turns,
    input,
    streaming,
    activity,
    announcement,
    suggestions,
    suggestActive,
    caseForm,
    logRef,
    inputRef,
    setCaseForm,
    send,
    stopStream,
    onInputChange,
    onInputKeyDown,
    pickSuggestion,
    submitCaseForm,
    componentContext,
  }
}
