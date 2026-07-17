/**
 * Scroll-reveal + count-up motion, as progressive enhancement.
 *
 * Design constraints (do not regress):
 *  - No-JS, `prefers-reduced-motion: reduce`, and Save-Data users must see fully
 *    rendered content with zero transforms. The hidden pre-state in global.css
 *    is gated behind `html.reveal-ready`, which is only added when motion is
 *    allowed (see the inline guard in Base.astro that sets it before first
 *    paint to avoid a flash-of-visible-then-hidden).
 *  - Elements opt in with `data-reveal` (optionally `="fade" | "scale" | "left"
 *    | "right"`). Stagger is automatic within a `data-reveal-group` container.
 *  - Count-up numbers opt in with `data-countup="<finalNumber>"`; the visible
 *    text is the real final value on load, so no-JS shows the correct number.
 */

const REVEAL_SELECTOR = "[data-reveal]"
const GROUP_SELECTOR = "[data-reveal-group]"
const COUNTUP_SELECTOR = "[data-countup]"

function motionAllowed(): boolean {
  if (typeof window === "undefined") return false
  if (!("IntersectionObserver" in window)) return false
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return false
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
  return connection?.saveData !== true
}

function assignStaggerIndices(): void {
  document.querySelectorAll<HTMLElement>(GROUP_SELECTOR).forEach((group) => {
    const items = Array.from(group.querySelectorAll<HTMLElement>(REVEAL_SELECTOR)).filter(
      (el) => el.closest(GROUP_SELECTOR) === group
    )
    items.forEach((el, index) => {
      if (!el.style.getPropertyValue("--reveal-index")) {
        el.style.setProperty("--reveal-index", String(index))
      }
    })
  })
}

function initReveals(): void {
  const elements = Array.from(document.querySelectorAll<HTMLElement>(REVEAL_SELECTOR))
  if (elements.length === 0) return

  const observer = new IntersectionObserver(
    (entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.classList.add("is-revealed")
        obs.unobserve(entry.target)
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.12 }
  )

  elements.forEach((el) => observer.observe(el))
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

function runCountUp(el: HTMLElement): void {
  const raw = el.dataset.countup ?? ""
  const target = Number.parseFloat(raw)
  if (!Number.isFinite(target)) return

  // Preserve the author's rendered formatting (leading zeros, suffix).
  const finalText = el.textContent ?? raw
  const match = finalText.match(/^(\D*)(\d[\d,]*)(.*)$/s)
  const prefix = match?.[1] ?? ""
  const suffix = match?.[3] ?? ""
  const digits = (match?.[2] ?? String(target)).replace(/,/g, "")
  const pad = digits.length
  const duration = Math.min(1600, 600 + target * 45)
  const start = performance.now()

  el.classList.add("tabular-nums")

  const tick = (now: number): void => {
    const progress = Math.min(1, (now - start) / duration)
    const value = Math.round(easeOutCubic(progress) * target)
    el.textContent = `${prefix}${String(value).padStart(pad, "0")}${suffix}`
    if (progress < 1) requestAnimationFrame(tick)
    else el.textContent = finalText
  }

  requestAnimationFrame(tick)
}

function initCountUps(): void {
  const numbers = Array.from(document.querySelectorAll<HTMLElement>(COUNTUP_SELECTOR))
  if (numbers.length === 0) return

  const observer = new IntersectionObserver(
    (entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        runCountUp(entry.target as HTMLElement)
        obs.unobserve(entry.target)
      }
    },
    { threshold: 0.6 }
  )

  numbers.forEach((el) => observer.observe(el))
}

export function initMotion(): void {
  if (!motionAllowed()) return
  assignStaggerIndices()
  initReveals()
  initCountUps()
}
