/** One example accumulates context; it never upgrades a finding's evidence state. */
class EvidenceJourney extends HTMLElement {
  private observer?: IntersectionObserver
  private tops: number[] = []
  private navPositions: number[] = []
  private anchor = 0
  private fits = true
  private frame = 0
  private stage = -1
  private progress?: HTMLElement
  private receipts: HTMLElement[] = []
  private report?: HTMLElement
  private resizeObserver?: ResizeObserver
  private chapters: HTMLElement[] = []
  private links: HTMLAnchorElement[] = []
  private scene?: HTMLElement
  private reduced = matchMedia("(prefers-reduced-motion: reduce)")

  connectedCallback() {
    this.chapters = Array.from(this.querySelectorAll<HTMLElement>("[data-journey-chapter]"))
    this.links = Array.from(this.querySelectorAll<HTMLAnchorElement>("[data-journey-link]"))
    this.scene = this.querySelector<HTMLElement>("[data-journey-scene]") ?? undefined
    if (!this.chapters.length || !this.scene) return
    this.progress = this.querySelector<HTMLElement>("[data-journey-progress]") ?? undefined
    this.receipts = Array.from(this.querySelectorAll<HTMLElement>("[data-receipt-stage]"))
    this.report = this.querySelector<HTMLElement>(".journey__report") ?? undefined
    this.resizeObserver = new ResizeObserver(this.measure)
    this.resizeObserver.observe(this)
    this.resizeObserver.observe(this.scene)
    this.reduced.addEventListener("change", this.handlePreference)
    document.addEventListener("visibilitychange", this.handleVisibility)
    this.measure()
    this.handlePreference()
    // Only track while the story is near the viewport. There is no idle loop,
    // media download, scroll interception or extra animation dependency.
    this.observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          addEventListener("scroll", this.queueUpdate, { passive: true })
          addEventListener("resize", this.measure, { passive: true })
          this.queueUpdate()
        } else {
          removeEventListener("scroll", this.queueUpdate)
          removeEventListener("resize", this.measure)
        }
      },
      { rootMargin: "200px" }
    )
    this.observer.observe(this)
  }

  disconnectedCallback() {
    this.observer?.disconnect()
    this.resizeObserver?.disconnect()
    cancelAnimationFrame(this.frame)
    this.frame = 0
    removeEventListener("scroll", this.queueUpdate)
    removeEventListener("resize", this.measure)
    this.reduced.removeEventListener("change", this.handlePreference)
    document.removeEventListener("visibilitychange", this.handleVisibility)
  }

  private handlePreference = () => {
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
      ?.saveData
    this.classList.toggle("is-enhanced", !this.reduced.matches && !saveData)
    this.queueUpdate()
  }

  private handleVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(this.frame)
      this.frame = 0
    } else this.queueUpdate()
  }

  private measure = () => {
    this.anchor = Math.min(innerHeight * 0.48, 360)
    const sceneHeight = this.scene?.offsetHeight ?? 0
    const rootSize = parseFloat(getComputedStyle(document.documentElement).fontSize)
    this.fits = sceneHeight + rootSize * 10 <= innerHeight
    this.tops = this.chapters.map((chapter) => chapter.getBoundingClientRect().top + scrollY)
    this.navPositions = this.links.map((link) => {
      const nav = link.parentElement
      return nav ? Math.max(0, link.offsetLeft - nav.clientWidth / 2 + link.clientWidth / 2) : 0
    })
    this.queueUpdate()
  }

  private queueUpdate = () => {
    if (this.frame || document.hidden) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      const anchor = scrollY + this.anchor
      const tops = this.tops
      let active = 0
      tops.forEach((top, index) => {
        if (top <= anchor) active = index
      })
      const nextTop = tops[active + 1]
      const fraction =
        nextTop === undefined
          ? 1
          : Math.max(0, Math.min(1, (anchor - tops[active]!) / (nextTop - tops[active]!)))
      const progress = (active + fraction) / (this.chapters.length - 1)
      this.classList.toggle("is-flow", !this.fits)
      this.setStage(active)
      this.scene?.style.setProperty("--journey-progress", String(Math.min(1, progress)))
    })
  }

  private setStage(index: number) {
    if (!this.scene || index === this.stage || index < 0 || index >= this.chapters.length) return
    this.stage = index
    const nav = this.links[index]?.parentElement
    const navLeft = this.navPositions[index] ?? 0
    this.links.forEach((link, position) => {
      if (position === index) link.setAttribute("aria-current", "step")
      else link.removeAttribute("aria-current")
    })
    if (nav) nav.scrollLeft = navLeft
    this.scene.dataset.stage = String(index)
    if (this.progress) this.progress.textContent = String(index + 1).padStart(2, "0") + " / 07"
    this.receipts.forEach((receipt) => {
      receipt.classList.toggle("is-collected", Number(receipt.dataset.receiptStage) <= index)
      receipt.classList.toggle("is-current", Number(receipt.dataset.receiptStage) === index)
    })
    this.report?.classList.toggle("is-assembled", index === this.chapters.length - 1)
  }
}

if (!customElements.get("evidence-journey")) {
  customElements.define("evidence-journey", EvidenceJourney)
}
