export const EVIDENCE_STATES = [
  {
    code: "DETECTED",
    label: "Detected candidate",
    meaning:
      "A scanner found a signal worth reviewing. Confidence can help prioritize it, but does not prove exploitability.",
    shipped: true,
  },
  {
    code: "VERIFIED",
    label: "Independently verified (future step)",
    meaning:
      "Defined for a future separate verification step: a separate receipt would have to support the finding. No shipped path produces this state today, so no finding is in it. Engine confidence alone never creates it.",
    shipped: false,
  },
  {
    code: "VALIDATED",
    label: "Retest-confirmed",
    meaning:
      "A server-owned deterministic retest found the relevant condition absent after a fix, with complete applicable coverage.",
    shipped: true,
  },
  {
    code: "INCONCLUSIVE",
    label: "Inconclusive",
    meaning:
      "The available retest evidence cannot establish that the condition is gone. The uncertainty remains visible.",
    shipped: true,
  },
] as const

export const SHIPPED_EVIDENCE_STATES = EVIDENCE_STATES.filter((state) => state.shipped)
