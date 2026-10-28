import type { MotionMediaManifest } from "../../lib/motion-manifest"

/** Decorative cinema uses native playback. Document scrolling never seeks a decoder. */
class ScrollWorld extends HTMLElement {
  private manifest!: MotionMediaManifest
  private video!: HTMLVideoElement
  private toggle!: HTMLButtonElement
  private reduced = matchMedia("(prefers-reduced-motion: reduce)")
  private observer?: IntersectionObserver
  private near = false
  private enabled = true
  private failed = false
  private variant = ""
  private epoch = 0
  private frame = 0
  private deadline = 0

  connectedCallback() {
    try {
      this.manifest = JSON.parse(this.dataset.worldManifest ?? "")
    } catch {
      return
    }
    this.video = this.querySelector<HTMLVideoElement>("[data-world-video]")!
    this.toggle = this.querySelector<HTMLButtonElement>("[data-world-toggle]")!
    if (!this.video || !this.toggle) return
    try {
      this.enabled = localStorage.getItem("lyra-motion") !== "off"
    } catch {
      /* optional */
    }
    this.video.loop = true
    this.video.muted = true
    this.toggle.hidden = false
    this.toggle.addEventListener("click", this.toggleMotion)
    this.video.addEventListener("error", this.fail)
    this.reduced.addEventListener("change", this.sync)
    document.addEventListener("visibilitychange", this.sync)
    addEventListener("resize", this.resize, { passive: true })
    this.observer = new IntersectionObserver(
      ([entry]) => {
        this.near = Boolean(entry?.isIntersecting)
        this.sync()
      },
      { rootMargin: "100px" }
    )
    this.observer.observe(this)
    this.sync()
  }

  disconnectedCallback() {
    this.observer?.disconnect()
    this.toggle?.removeEventListener("click", this.toggleMotion)
    this.video?.removeEventListener("error", this.fail)
    this.reduced.removeEventListener("change", this.sync)
    document.removeEventListener("visibilitychange", this.sync)
    removeEventListener("resize", this.resize)
    this.release()
  }

  private allowed() {
    return (
      this.enabled &&
      !this.reduced.matches &&
      !(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData
    )
  }

  private mediaVariant() {
    return innerWidth < 1024 && innerHeight > innerWidth ? "portrait" : "desktop"
  }

  private resize = () => {
    // Browser chrome and viewport height changes do not reload the film.
    if (this.variant && this.variant !== this.mediaVariant()) {
      this.release()
      this.sync()
    }
  }

  private toggleMotion = () => {
    this.enabled = this.failed || !this.enabled
    this.failed = false
    try {
      localStorage.setItem("lyra-motion", this.enabled ? "on" : "off")
    } catch {
      /* optional */
    }
    this.sync()
  }

  private sync = () => {
    if (!this.isConnected || !this.video) return
    const allowed = this.allowed()
    this.toggle.setAttribute("aria-pressed", String(allowed && !this.failed))
    this.querySelector("[data-world-toggle-label]")!.textContent = this.failed
      ? "unavailable"
      : allowed
        ? "on"
        : "off"
    if (!allowed) {
      this.release()
      this.dataset.worldState = "static"
      return
    }
    if (this.failed) return
    if (!this.near || document.hidden) {
      this.video.pause()
      clearTimeout(this.deadline)
      return
    }
    if (!this.video.getAttribute("src")) {
      this.variant = this.mediaVariant()
      this.video.src = this.manifest[this.variant === "portrait" ? "portrait" : "desktop"].src
      this.video.preload = "auto"
      this.dataset.worldState = "loading"
    }
    const epoch = this.epoch
    if (!("requestVideoFrameCallback" in this.video)) {
      this.fail()
      return
    }
    if (!this.frame && this.dataset.worldPainted !== "true") {
      this.frame = this.video.requestVideoFrameCallback(() => {
        if (epoch !== this.epoch) return
        this.frame = 0
        clearTimeout(this.deadline)
        if (!this.allowed()) {
          this.sync()
          return
        }
        this.dataset.worldPainted = "true"
        this.dataset.worldState = "ready"
      })
    }
    clearTimeout(this.deadline)
    if (this.dataset.worldPainted !== "true") this.deadline = window.setTimeout(this.fail, 8000)
    void this.video.play().catch((error: unknown) => {
      if (epoch !== this.epoch || !this.near || document.hidden || !this.allowed()) return
      if (error instanceof DOMException && error.name === "AbortError") return
      this.fail()
    })
  }

  private release() {
    this.epoch++
    clearTimeout(this.deadline)
    if (!this.video) return
    if (this.frame) this.video.cancelVideoFrameCallback(this.frame)
    this.frame = 0
    this.video.pause()
    this.video.removeAttribute("src")
    this.video.preload = "none"
    this.video.load()
    this.variant = ""
    delete this.dataset.worldPainted
  }

  private fail = () => {
    if (!this.video?.getAttribute("src")) return
    this.failed = true
    this.release()
    this.dataset.worldState = "fallback"
    this.toggle.setAttribute("aria-pressed", "false")
    this.querySelector("[data-world-toggle-label]")!.textContent = "unavailable"
    const status = this.querySelector("[data-world-status]")
    if (status)
      status.textContent = "Animation unavailable. The complete evidence story remains available."
  }
}
if (!customElements.get("scroll-world")) customElements.define("scroll-world", ScrollWorld)
