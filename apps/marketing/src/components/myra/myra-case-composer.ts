import { add, el } from "./myra-dom-renderer"
import { getMyraSessionId, getTurnstileToken, myraHeaders } from "./myra-session"

export function openMyraCaseComposer(options: {
  apiBase: string
  logEl: HTMLElement
  emptyEl: HTMLElement | null
  getLastTraceId: () => string | undefined
  scrollToBottom: () => void
  announce: (text: string) => void
  send: (text: string) => void
}) {
  const { apiBase, logEl, emptyEl, getLastTraceId, scrollToBottom, announce, send } = options

  if (document.getElementById("myra-case-form")) {
    document.getElementById("myra-case-form")?.scrollIntoView({ block: "nearest" })
    return
  }
  emptyEl?.setAttribute("hidden", "")
  const card = el("section", "myra-card myra-case-form")
  card.id = "myra-case-form"
  add(card, el("p", "myra-card-title", "Talk to a person"))
  add(
    card,
    el(
      "p",
      "myra-note",
      "Tell us what happened. Myra will prepare a case summary for you to review before anything is sent."
    )
  )
  const subject = el("input", "myra-field") as HTMLInputElement
  subject.maxLength = 160
  subject.placeholder = "Subject"
  subject.setAttribute("aria-label", "Case subject")
  const summary = el("textarea", "myra-field") as HTMLTextAreaElement
  summary.rows = 4
  summary.maxLength = 4000
  summary.placeholder = "What happened? What were you trying to do?"
  summary.setAttribute("aria-label", "Case details")
  const email = el("input", "myra-field") as HTMLInputElement
  email.type = "email"
  email.maxLength = 320
  email.placeholder = "Email for replies"
  email.setAttribute("aria-label", "Email for replies")
  const diagLabel = el("label", "myra-check")
  const diag = el("input") as HTMLInputElement
  diag.type = "checkbox"
  add(diagLabel, diag, document.createTextNode(" Include a diagnostic excerpt"))
  const transcriptLabel = el("label", "myra-check")
  const transcript = el("input") as HTMLInputElement
  transcript.type = "checkbox"
  add(transcriptLabel, transcript, document.createTextNode(" Include a transcript excerpt"))
  const state = el("p", "myra-note")
  const row = el("div", "myra-card-actions")
  const submit = el("button", "myra-btn myra-btn-primary", "Continue")
  submit.type = "button"
  const dismiss = el("button", "myra-btn", "Close")
  dismiss.type = "button"
  dismiss.addEventListener("click", () => card.remove())

  const verifyRow = el("div", "myra-verify")
  verifyRow.hidden = true
  const code = el("input", "myra-field") as HTMLInputElement
  code.inputMode = "numeric"
  code.maxLength = 12
  code.placeholder = "Code"
  code.setAttribute("aria-label", "Verification code")
  const verify = el("button", "myra-btn myra-btn-primary", "Verify")
  verify.type = "button"
  add(verifyRow, code, verify)

  const sessionId = getMyraSessionId()

  function sendCaseMessage() {
    const subjectText = subject.value.trim()
    const summaryText = summary.value.trim()
    const parts = [
      "Please prepare a support case for me.",
      `Subject: ${subjectText}`,
      `Details: ${summaryText}`,
      `Reply email: ${email.value.trim()}`,
      `Include diagnostic excerpt: ${diag.checked ? "yes" : "no"}`,
      `Include transcript excerpt: ${transcript.checked ? "yes" : "no"}`,
    ]
    const lastTraceId = getLastTraceId()
    if (lastTraceId) parts.push(`Attach trace: ${lastTraceId}`)
    card.remove()
    send(parts.join("\n"))
  }

  verify.addEventListener("click", () => {
    const codeText = code.value.trim()
    if (codeText.length < 4) {
      state.textContent = "Enter the code from the email."
      return
    }
    verify.disabled = true
    fetch(`${apiBase}/api/myra/identity/confirm`, {
      method: "POST",
      credentials: "omit",
      headers: myraHeaders(),
      body: JSON.stringify({
        email: email.value.trim(),
        purpose: "support_case",
        code: codeText,
      }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status))
        state.textContent = "Verified — preparing your case draft."
        sendCaseMessage()
      })
      .catch(() => {
        verify.disabled = false
        state.textContent = "That code did not work. Try again."
      })
  })

  submit.addEventListener("click", () => {
    const subjectText = subject.value.trim()
    const summaryText = summary.value.trim()
    const emailText = email.value.trim()
    if (subjectText.length < 4 || summaryText.length < 10) {
      announce("Add a subject and a few words about what happened.")
      summary.focus()
      return
    }
    if (!emailText.includes("@")) {
      state.textContent = "Enter the email replies should go to."
      email.focus()
      return
    }
    submit.disabled = true
    state.textContent = "Sending a verification code…"
    getTurnstileToken()
      .then((turnstileToken) =>
        fetch(`${apiBase}/api/myra/identity/request`, {
          method: "POST",
          credentials: "omit",
          headers: myraHeaders(),
          body: JSON.stringify({
            email: emailText,
            purpose: "support_case",
            ...(sessionId ? { publicSessionId: sessionId } : {}),
            ...(turnstileToken ? { turnstileToken } : {}),
          }),
        })
      )
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status))
        state.textContent = `We emailed a short code to ${emailText}.`
        verifyRow.hidden = false
        submit.hidden = true
        email.disabled = true
        code.focus()
      })
      .catch(() => {
        submit.disabled = false
        state.textContent = "We could not send a code. Try again in a minute."
      })
  })
  add(row, submit, dismiss)
  add(card, subject, summary, email, diagLabel, transcriptLabel, verifyRow, row, state)
  add(logEl, card)
  scrollToBottom()
  subject.focus()
  announce("Case form opened.")
}
