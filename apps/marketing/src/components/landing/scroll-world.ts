import {
  easeVideoTime,
  sampleScroll,
  validateBands,
  type ChapterBand,
} from "../../lib/scroll-world-mapping"
import type { MotionMediaManifest } from "../../lib/motion-manifest"

/** Native scrolling owns position; the media layer is a bounded follower. */
class ScrollWorld extends HTMLElement {
  private manifest!: MotionMediaManifest
  private video!: HTMLVideoElement
  private poster!: HTMLImageElement
  private source?: HTMLSourceElement
  private toggle!: HTMLButtonElement
  private bands: ChapterBand[] = []
  private reduced = matchMedia("(prefers-reduced-motion: reduce)")
  private resize?: ResizeObserver
  private visibility?: IntersectionObserver
  private frame = 0
  private canvas!: HTMLCanvasElement
  private context!: CanvasRenderingContext2D
  private deadline = 0
  private variant = ""
  private width = 0
  private desired = 0
  private eased = 0
  private motionFrom = 0
  private motionStart = 0
  private inFlight = false
  private priming = false
  private activeChapter = "gateway"
  private near = false
  private enabled = true
  private failed = false
  private epoch = 0
  private anchor = 0
  private fps = 30

  private mediaVariant() {
    return innerWidth < 1024 && innerHeight > innerWidth ? "portrait" : "desktop"
  }

  connectedCallback() {
    try {
      this.manifest = JSON.parse(this.dataset.worldManifest ?? "")
    } catch {
      return
    }
    this.fps = this.manifest.fps
    this.video = this.querySelector<HTMLVideoElement>("[data-world-video]")!
    this.poster = this.querySelector<HTMLImageElement>("[data-world-poster] img")!
    this.source = this.querySelector<HTMLSourceElement>("[data-world-poster] source") ?? undefined
    this.toggle = this.querySelector<HTMLButtonElement>("[data-world-toggle]")!
    if (!this.video || !this.poster || !this.toggle) return
    this.canvas = document.createElement("canvas")
    this.canvas.setAttribute("aria-hidden", "true")
    this.canvas.className = "scroll-world__canvas"
    this.video.parentElement!.insertBefore(this.canvas, this.video.nextSibling)
    const context = this.canvas.getContext("2d", { alpha: false })
    if (!context) return
    this.context = context
    this.toggle.hidden = false
    try {
      this.enabled = localStorage.getItem("lyra-motion") !== "off"
    } catch {
      /* storage is optional */
    }
    this.toggle.addEventListener("click", this.toggleMotion)
    this.reduced.addEventListener("change", this.preference)
    this.video.addEventListener("loadedmetadata", this.metadata)
    this.video.addEventListener("seeked", this.seeked)
    this.video.addEventListener("loadeddata", this.present)
    this.video.addEventListener("error", this.mediaError)
    document.addEventListener("visibilitychange", this.documentVisibility)
    addEventListener("resize", this.geometry, { passive: true })
    this.resize = new ResizeObserver(this.measure)
    this.resize.observe(this)
    this.querySelectorAll<HTMLElement>("[data-journey-chapter], .premium-hero").forEach((chapter) =>
      this.resize!.observe(chapter)
    )
    const header = document.querySelector("header")
    if (header) this.resize.observe(header)
    document.fonts.ready.then(() => {
      if (this.isConnected) this.measure()
    })
    this.visibility = new IntersectionObserver(
      ([entry]) => {
        this.near = Boolean(entry?.isIntersecting)
        if (this.near) {
          addEventListener("scroll", this.queue, { passive: true })
          this.measure()
          this.preference()
          if (
            this.ensureActiveMedia() &&
            this.video.readyState >= 1 &&
            (this.inFlight || this.priming)
          ) {
            this.present()
            if (this.inFlight || this.priming) this.armDeadline(2000)
          }
        } else {
          removeEventListener("scroll", this.queue)
          cancelAnimationFrame(this.frame)
          this.frame = 0
          this.clearDeadline()
          this.video.pause()
        }
      },
      { rootMargin: "200px" }
    )
    this.visibility.observe(this)
    this.measure()
    this.preference()
  }

  disconnectedCallback() {
    this.visibility?.disconnect()
    this.resize?.disconnect()
    removeEventListener("scroll", this.queue)
    removeEventListener("resize", this.geometry)
    document.removeEventListener("visibilitychange", this.documentVisibility)
    this.reduced.removeEventListener("change", this.preference)
    this.toggle?.removeEventListener("click", this.toggleMotion)
    this.video?.removeEventListener("loadedmetadata", this.metadata)
    this.video?.removeEventListener("seeked", this.seeked)
    this.video?.removeEventListener("loadeddata", this.present)
    this.canvas?.remove()
    this.video?.removeEventListener("error", this.mediaError)
    cancelAnimationFrame(this.frame)
    this.release()
  }

  private allowed() {
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
      ?.saveData
    return this.enabled && !this.reduced.matches && !saveData
  }

  private ensureActiveMedia() {
    if (!this.isConnected) return false
    // Preference notifications may trail already queued media work.
    if (!this.allowed()) {
      if (this.dataset.worldState !== "static") this.preference()
      return false
    }
    return !this.failed && !!this.video.getAttribute("src")
  }

  private mediaError = () => {
    if (this.ensureActiveMedia()) this.fail()
  }

  private toggleMotion = () => {
    this.enabled = this.failed || !this.allowed()
    this.failed = false
    try {
      localStorage.setItem("lyra-motion", this.enabled ? "on" : "off")
    } catch {
      /* optional */
    }
    this.preference()
  }

  private preference = () => {
    const on = this.allowed()
    this.toggle.setAttribute("aria-pressed", String(on))
    this.querySelector("[data-world-toggle-label]")!.textContent = on ? "on" : "off"
    if (!on) {
      this.release()
      this.dataset.worldState = "static"
      this.queue()
    } else if (this.near && !this.failed && !this.video.getAttribute("src")) this.loadVariant()
  }

  private geometry = () => {
    // Browser-chrome height changes only recompose when the selected media variant changes.
    if (this.width === innerWidth && (!this.variant || this.variant === this.mediaVariant())) return
    this.measure()
  }

  private measure = () => {
    if (!this.isConnected) return
    this.width = innerWidth
    this.anchor = Math.min(innerHeight * 0.48, 360)
    const header = document.querySelector("header")?.getBoundingClientRect().height ?? 64
    this.style.setProperty("--world-top", `${header}px`)
    this.style.setProperty("--world-height", `${Math.max(320, innerHeight - header)}px`)
    const chapters = this.manifest.chapters
    const elements = chapters.map((chapter, i) =>
      i === 0
        ? (this.querySelector<HTMLElement>(".premium-hero") ??
          this.querySelector<HTMLElement>("#journey-gateway"))
        : this.querySelector<HTMLElement>(`#journey-${chapter.id}`)
    )
    if (elements.some((element) => !element)) return
    const tops = elements.map((element) => element!.getBoundingClientRect().top + scrollY)
    this.bands = chapters.map((chapter, i) => ({
      id: chapter.id,
      start: chapter.start,
      end: chapter.end,
      // Start at the opening frame on arrival. The viewport sampling anchor
      // must not seek several seconds into the film before the visitor scrolls.
      top: i === 0 ? Math.max(tops[i]!, this.anchor) : tops[i]!,
      bottom: tops[i + 1] ?? tops[i]! + elements[i]!.offsetHeight,
    }))
    if (!validateBands(this.bands)) {
      this.fail()
      return
    }
    const next = this.mediaVariant()
    if (this.variant && next !== this.variant) {
      this.release()
      this.variant = ""
      if (this.near && this.allowed() && !this.failed) this.loadVariant()
    }
    this.queue()
  }

  private loadVariant() {
    this.variant = this.mediaVariant()
    const track = this.variant === "portrait" ? this.manifest.portrait : this.manifest.desktop
    this.dataset.worldState = "loading"
    const status = this.querySelector("[data-world-status]")
    if (status) status.textContent = ""
    // readyState can change before loadedmetadata is dispatched. Block scroll
    // seeks until the first frame has completed the startup handshake.
    this.priming = true
    // Decode while paused. Only completed frames are copied to the canvas.
    this.video.pause()
    this.video.crossOrigin = "anonymous"
    this.video.src = track.src
    this.video.preload = "auto"
    this.video.load()
    this.armDeadline(5000)
  }

  private metadata = () => {
    if (!this.ensureActiveMedia()) return
    if (!Number.isFinite(this.video.duration) || this.video.duration <= 0) {
      this.fail()
      return
    }
    this.canvas.width = this.video.videoWidth
    this.canvas.height = this.video.videoHeight
  }

  private seeked = () => {
    if (!this.ensureActiveMedia()) return
    this.present()
    this.queue()
  }

  /** Copy a completed paused seek; never play forward to force a compositor callback. */
  private present = () => {
    if (
      !this.ensureActiveMedia() ||
      !this.near ||
      document.hidden ||
      this.video.seeking ||
      this.video.readyState < 2
    )
      return
    try {
      this.context.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height)
    } catch {
      this.fail()
      return
    }
    this.priming = false
    this.inFlight = false
    this.clearDeadline()
    this.dataset.worldPresented = this.video.currentTime.toFixed(3)
    this.dataset.worldPainted = "true"
    this.dataset.worldState = "ready"
    const chapter = this.manifest.chapters.find(
      (c) => this.video.currentTime >= c.start && this.video.currentTime < c.end
    )
    if (chapter && chapter.id !== this.dataset.worldChapter) {
      this.dataset.worldChapter = chapter.id
      this.dispatchEvent(new Event("world-frame"))
    }
    this.queue()
  }

  private queue = () => {
    if (this.frame || !this.near || document.hidden || !this.bands.length) return
    this.frame = requestAnimationFrame((now) => {
      this.frame = 0
      const sample = sampleScroll(scrollY + this.anchor, this.bands)
      const time = Math.max(0, Math.min(this.manifest.desktop.duration - 1 / this.fps, sample.time))
      this.eased = easeVideoTime(this.motionFrom, this.desired, now - this.motionStart)
      const next = Math.round(time * this.fps) / this.fps
      if (next !== this.desired) {
        this.motionFrom = this.eased
        this.motionStart = now
        this.desired = next
      }
      if (sample.chapter !== this.activeChapter) {
        this.activeChapter = sample.chapter
        // Keep the last decoded frame visible while easing across a chapter.
        this.updatePoster()
      }
      this.dataset.worldTime = this.desired.toFixed(3)
      if (this.ensureActiveMedia()) {
        this.flush()
        if (Math.abs(this.eased - this.desired) > 0.001) this.queue()
      }
    })
  }

  private updatePoster() {
    const chapter = this.manifest.chapters.find((chapter) => chapter.id === this.activeChapter)!
    if (this.source) this.source.srcset = chapter.portraitPoster
    this.poster.src = chapter.desktopPoster
  }

  private flush() {
    if (
      !this.near ||
      document.hidden ||
      this.failed ||
      !this.allowed() ||
      this.video.readyState < 1 ||
      this.video.seeking ||
      this.inFlight ||
      this.priming
    )
      return
    const target = Math.round(this.eased * this.fps) / this.fps
    if (Math.abs(this.video.currentTime - target) < 0.5 / this.fps) return
    this.inFlight = true
    this.video.currentTime = target
    if (!this.deadline) this.armDeadline(2000)
  }

  private armDeadline(ms: number) {
    this.clearDeadline()
    const epoch = this.epoch
    this.deadline = window.setTimeout(() => {
      if (epoch === this.epoch && this.ensureActiveMedia()) this.fail()
    }, ms)
  }
  private clearDeadline() {
    clearTimeout(this.deadline)
    this.deadline = 0
  }
  private release() {
    this.epoch++
    this.clearDeadline()
    if (!this.video) return
    this.video.pause()
    this.video.removeAttribute("src")
    this.video.preload = "none"
    this.video.load()
    this.inFlight = false
    this.priming = false
    delete this.dataset.worldPainted
  }
  private fail = () => {
    this.failed = true
    this.release()
    this.dataset.worldState = "fallback"
    this.toggle.setAttribute("aria-pressed", "false")
    this.querySelector("[data-world-toggle-label]")!.textContent = "unavailable"
    const status = this.querySelector("[data-world-status]")
    if (status)
      status.textContent = "Animation unavailable. The complete evidence story remains available."
  }
  private documentVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(this.frame)
      this.frame = 0
      this.clearDeadline()
      this.video.pause()
    } else {
      this.queue()
      if (this.allowed() && !this.failed && this.near && (this.inFlight || this.priming)) {
        this.present()
        if (this.inFlight || this.priming) this.armDeadline(2000)
      }
    }
  }
}
if (!customElements.get("scroll-world")) customElements.define("scroll-world", ScrollWorld)
