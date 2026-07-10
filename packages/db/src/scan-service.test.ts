import { describe, it, expect } from "vitest"
import { isValidTransition } from "./scan-transitions"

describe("Scan Lifecycle — State Machine Transitions", () => {
  describe("valid transitions", () => {
    it("QUEUED → PREFLIGHT", () => {
      expect(isValidTransition("QUEUED", "PREFLIGHT")).toBe(true)
    })
    it("QUEUED → CANCELLED", () => {
      expect(isValidTransition("QUEUED", "CANCELLED")).toBe(true)
    })
    it("QUEUED → FAILED", () => {
      expect(isValidTransition("QUEUED", "FAILED")).toBe(true)
    })
    it("PREFLIGHT → RUNNING", () => {
      expect(isValidTransition("PREFLIGHT", "RUNNING")).toBe(true)
    })
    it("allows a retry to return to PREFLIGHT from an interrupted stage", () => {
      expect(isValidTransition("PREFLIGHT", "PREFLIGHT")).toBe(true)
      expect(isValidTransition("RUNNING", "PREFLIGHT")).toBe(true)
      expect(isValidTransition("VERIFYING", "PREFLIGHT")).toBe(true)
    })
    it("PREFLIGHT → REQUIRES_APPROVAL", () => {
      expect(isValidTransition("PREFLIGHT", "REQUIRES_APPROVAL")).toBe(true)
    })
    it("RUNNING → VERIFYING", () => {
      expect(isValidTransition("RUNNING", "VERIFYING")).toBe(true)
    })
    it("RUNNING → FAILED", () => {
      expect(isValidTransition("RUNNING", "FAILED")).toBe(true)
    })
    it("RUNNING → STOPPED_BUDGET", () => {
      expect(isValidTransition("RUNNING", "STOPPED_BUDGET")).toBe(true)
    })
    it("RUNNING → TIMED_OUT", () => {
      expect(isValidTransition("RUNNING", "TIMED_OUT")).toBe(true)
    })
    it("VERIFYING → COMPLETED", () => {
      expect(isValidTransition("VERIFYING", "COMPLETED")).toBe(true)
    })
    it("REQUIRES_APPROVAL → RUNNING", () => {
      expect(isValidTransition("REQUIRES_APPROVAL", "RUNNING")).toBe(true)
    })
  })

  describe("invalid transitions", () => {
    it("QUEUED → RUNNING (must go through PREFLIGHT)", () => {
      expect(isValidTransition("QUEUED", "RUNNING")).toBe(false)
    })
    it("QUEUED → COMPLETED (must go through PREFLIGHT → RUNNING → VERIFYING)", () => {
      expect(isValidTransition("QUEUED", "COMPLETED")).toBe(false)
    })
    it("PREFLIGHT → COMPLETED (must go through RUNNING → VERIFYING)", () => {
      expect(isValidTransition("PREFLIGHT", "COMPLETED")).toBe(false)
    })
    it("RUNNING → COMPLETED (must go through VERIFYING)", () => {
      expect(isValidTransition("RUNNING", "COMPLETED")).toBe(false)
    })
    it("COMPLETED → anything (terminal state)", () => {
      expect(isValidTransition("COMPLETED", "QUEUED")).toBe(false)
      expect(isValidTransition("COMPLETED", "RUNNING")).toBe(false)
      expect(isValidTransition("COMPLETED", "FAILED")).toBe(false)
    })
    it("FAILED → anything (terminal state)", () => {
      expect(isValidTransition("FAILED", "QUEUED")).toBe(false)
      expect(isValidTransition("FAILED", "RUNNING")).toBe(false)
      expect(isValidTransition("FAILED", "COMPLETED")).toBe(false)
    })
    it("CANCELLED → anything (terminal state)", () => {
      expect(isValidTransition("CANCELLED", "QUEUED")).toBe(false)
      expect(isValidTransition("CANCELLED", "RUNNING")).toBe(false)
    })
    it("STOPPED_BUDGET → anything (terminal state)", () => {
      expect(isValidTransition("STOPPED_BUDGET", "RUNNING")).toBe(false)
      expect(isValidTransition("STOPPED_BUDGET", "COMPLETED")).toBe(false)
    })
    it("TIMED_OUT → anything (terminal state)", () => {
      expect(isValidTransition("TIMED_OUT", "RUNNING")).toBe(false)
      expect(isValidTransition("TIMED_OUT", "COMPLETED")).toBe(false)
    })
  })

  describe("all terminal states have no valid outgoing transitions", () => {
    const terminalStates = ["COMPLETED", "FAILED", "CANCELLED", "STOPPED_BUDGET", "TIMED_OUT"] as const
    const allStates = ["QUEUED", "PREFLIGHT", "RUNNING", "VERIFYING", "COMPLETED", "FAILED", "CANCELLED", "REQUIRES_APPROVAL", "STOPPED_BUDGET", "TIMED_OUT"] as const

    for (const terminal of terminalStates) {
      it(`${terminal} has no valid transitions to any state`, () => {
        for (const target of allStates) {
          expect(isValidTransition(terminal, target)).toBe(false)
        }
      })
    }
  })
})
