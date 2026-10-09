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
  private presentation = 0
  private deadline = 0
  private variant = ""
  private width = 0
  private desired = 0
  private eased = 0
  private motionFrom = 0
  private motionStart = 0
  private inFlight = false
  private priming = false
  private requested = 0
  private activeChapter = "gateway"
  private near = false
  private enabled = true
  private failed = false
  private epoch = 0
  private anchor = 0
  private fps = 30

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
    this.video.addEventListener("error", this.fail)
    document.addEventListener("visibilitychange", this.documentVisibility)
    addEventListener("resize", this.geometry, { passive: true })
    this.resize = new ResizeObserver(this.measure)
    this.resize.observe(this)
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
        } else {
          removeEventListener("scroll", this.queue)
          cancelAnimationFrame(this.frame)
          this.frame = 0
          this.clearDeadline()
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
    this.video?.removeEventListener("error", this.fail)
    cancelAnimationFrame(this.frame)
    this.release()
  }

  private allowed() {
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
      ?.saveData
    return this.enabled && !this.reduced.matches && !saveData
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
    // Mobile browser chrome changes height while scrolling; width changes own recomposition.
    if (this.width === innerWidth) return
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
      top: tops[i]!,
      bottom: tops[i + 1] ?? tops[i]! + elements[i]!.offsetHeight,
    }))
    if (!validateBands(this.bands)) {
      this.fail()
      return
    }
    const next = innerWidth < 1024 ? "portrait" : "desktop"
    if (this.variant && next !== this.variant) {
      this.release()
      this.variant = ""
      if (this.near && this.allowed() && !this.failed) this.loadVariant()
    }
    this.queue()
  }

  private loadVariant() {
    if (!("requestVideoFrameCallback" in this.video)) {
      this.fail()
      return
    }
    this.variant = innerWidth < 1024 ? "portrait" : "desktop"
    const track = this.variant === "portrait" ? this.manifest.portrait : this.manifest.desktop
    this.dataset.worldState = "loading"
    // readyState can change before loadedmetadata is dispatched. Block scroll
    // seeks until the first frame has completed the startup handshake.
    this.priming = true
    this.requested = 0
    // A brief, slow prime makes occluded portrait frames reach the compositor
    // without advancing past the requested frame before it can be acknowledged.
    this.video.defaultPlaybackRate = 0.25
    this.video.src = track.src
    this.video.preload = "auto"
    this.video.load()
    this.armDeadline(5000)
  }

  private metadata = () => {
    if (!Number.isFinite(this.video.duration) || this.video.duration <= 0) {
      this.fail()
      return
    }
    // Register only after load() has reset the media resource. Pause after an
    // actual presented frame, not when the play promise merely resolves.
    this.priming = true
    this.observeFrame()
    this.prime()
  }

  private seeked = () => {
    this.observeFrame()
    if (this.inFlight && this.allowed() && !this.failed && !document.hidden) {
      this.prime()
    }
    // A presentation callback may precede seeked. Resume the latest coalesced
    // request after decoder completion even if the preceding rAF saw seeking.
    this.queue()
  }

  private prime() {
    const epoch = this.epoch
    void this.video.play().catch((error: unknown) => {
      // Our acknowledged frame pauses playback and can abort a pending play
      // promise. The presentation watchdog still catches an actual stall.
      if (epoch !== this.epoch || (error instanceof DOMException && error.name === "AbortError"))
        return
      this.fail()
    })
  }

  private queue = () => {
    if (this.frame || document.hidden || !this.bands.length) return
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
      if (this.allowed() && !this.failed) {
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
    this.requested = target
    this.observeFrame()
    this.video.currentTime = target
    if (!this.deadline) this.armDeadline(2000)
  }

  private observeFrame() {
    if (this.presentation || !("requestVideoFrameCallback" in this.video)) return
    const epoch = this.epoch
    this.presentation = this.video.requestVideoFrameCallback((_now, metadata) => {
      this.presentation = 0
      if (epoch !== this.epoch || !this.isConnected) return
      this.dataset.worldPresented = metadata.mediaTime.toFixed(3)
      if (this.priming) {
        this.priming = false
        this.video.pause()
        this.clearDeadline()
      }
      const currentChapter = this.manifest.chapters.find(
        (chapter) => this.desired >= chapter.start && this.desired < chapter.end
      )
      const correctChapter =
        currentChapter &&
        metadata.mediaTime >= currentChapter.start - 1 / this.fps &&
        metadata.mediaTime < currentChapter.end
      if (Math.abs(metadata.mediaTime - this.requested) <= 1.1 / this.fps) {
        this.video.pause()
        this.inFlight = false
        this.clearDeadline()
        if (correctChapter) {
          this.dataset.worldPainted = "true"
          this.dataset.worldState = "ready"
        }
      } else if (
        this.inFlight &&
        !this.video.seeking &&
        metadata.mediaTime > this.requested + 1.1 / this.fps
      ) {
        // A busy main thread may deliver the first frame after playback has
        // already passed our target. Stop drift and correct the same seek;
        // keep its original deadline so a genuine stall remains bounded.
        this.video.pause()
        this.video.currentTime = this.requested
      }
      this.queue()
      this.observeFrame()
    })
  }

  private armDeadline(ms: number) {
    this.clearDeadline()
    this.deadline = window.setTimeout(this.fail, ms)
  }
  private clearDeadline() {
    clearTimeout(this.deadline)
    this.deadline = 0
  }
  private release() {
    this.epoch++
    this.clearDeadline()
    if (!this.video) return
    if (this.presentation) this.video.cancelVideoFrameCallback(this.presentation)
    this.presentation = 0
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
    } else {
      this.queue()
      if (this.allowed() && !this.failed && this.near && (this.inFlight || this.priming))
        this.armDeadline(2000)
    }
  }
}
if (!customElements.get("scroll-world")) customElements.define("scroll-world", ScrollWorld)
