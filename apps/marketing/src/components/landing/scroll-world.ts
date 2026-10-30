import {
  easeVideoTime,
  sampleScroll,
  validateBands,
  type ChapterBand,
} from "../../lib/scroll-world-mapping"
import type { MotionMediaManifest } from "../../lib/motion-manifest"
import { canAutoLoadMotion, type MotionConnection } from "../../lib/motion-loading"
import { bufferMotion } from "../../lib/buffer-motion"
import { MOTION_VARIANTS } from "../../../../marketing-motion/scripts/motion-media-contract.mjs"

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
  private download?: AbortController
  private objectUrl = ""
  private explicitPlay = false
  private pageLoaded = document.readyState === "complete"
  private cancelScheduled?: () => void
  private connection = (navigator as Navigator & { connection?: MotionConnection }).connection

  private mediaVariant() {
    return innerWidth < 1024 && innerHeight > innerWidth ? "portrait" : "desktop"
  }

  connectedCallback() {
    this.pageLoaded = document.readyState === "complete"
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
    this.connection?.addEventListener?.("change", this.preference)
    addEventListener("load", this.loaded, { once: true })
    this.video.addEventListener("loadedmetadata", this.metadata)
    this.video.addEventListener("seeked", this.seeked)
    this.video.addEventListener("error", this.mediaError)
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
          this.release()
          if (this.allowed()) this.dataset.worldState = "poster"
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
    this.connection?.removeEventListener?.("change", this.preference)
    removeEventListener("load", this.loaded)
    this.toggle?.removeEventListener("click", this.toggleMotion)
    this.video?.removeEventListener("loadedmetadata", this.metadata)
    this.video?.removeEventListener("seeked", this.seeked)
    this.video?.removeEventListener("error", this.mediaError)
    cancelAnimationFrame(this.frame)
    this.release()
  }

  private allowed() {
    return this.enabled && !this.reduced.matches && !this.connection?.saveData
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
    this.enabled = this.failed || !this.allowed() || !this.authorized()
    this.explicitPlay = this.enabled
    this.failed = false
    try {
      localStorage.setItem("lyra-motion", this.enabled ? "on" : "off")
    } catch {
      /* optional */
    }
    this.preference()
  }

  private authorized() {
    return this.allowed() && (this.explicitPlay || canAutoLoadMotion(this.connection))
  }

  private loaded = () => {
    this.pageLoaded = true
    this.preference()
  }

  private preference = () => {
    const on = this.authorized()
    const blocked = this.reduced.matches || Boolean(this.connection?.saveData)
    this.toggle.disabled = blocked
    this.toggle.setAttribute("aria-pressed", String(on && !this.failed))
    const budget = MOTION_VARIANTS[this.mediaVariant()].budgetBytes / (1024 * 1024)
    this.querySelector("[data-world-toggle-label]")!.textContent = this.failed
      ? "Motion unavailable"
      : !this.allowed()
        ? "Motion off"
        : on
          ? "Motion on"
          : `Play motion (up to ${budget} MiB)`
    if (!on) {
      this.release()
      this.dataset.worldState = this.allowed() ? "poster" : "static"
      this.queue()
    } else this.scheduleMedia()
  }

  private scheduleMedia() {
    if (
      !this.isConnected ||
      !this.pageLoaded ||
      !this.near ||
      document.hidden ||
      !this.authorized() ||
      this.failed ||
      this.video.getAttribute("src") ||
      this.download ||
      this.cancelScheduled
    )
      return
    // Downloads start only after window load and an idle turn, even when the
    // network hint or an explicit play request permits them.
    const epoch = this.epoch
    const run = () => {
      if (epoch !== this.epoch) return
      this.cancelScheduled = undefined
      if (
        this.isConnected &&
        this.near &&
        !document.hidden &&
        this.authorized() &&
        !this.failed &&
        !this.download &&
        !this.video.getAttribute("src")
      )
        void this.loadVariant()
    }
    if (typeof window.requestIdleCallback === "function") {
      const idle = window.requestIdleCallback(run)
      this.cancelScheduled = () => window.cancelIdleCallback(idle)
    } else {
      const timeout = window.setTimeout(run, 200)
      this.cancelScheduled = () => clearTimeout(timeout)
    }
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
      top: tops[i]!,
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
      this.scheduleMedia()
    }
    this.preference()
    this.queue()
  }

  private async loadVariant() {
    if (!("requestVideoFrameCallback" in this.video)) {
      this.fail()
      return
    }
    this.variant = this.mediaVariant()
    this.dataset.worldVariant = this.variant
    const track = this.variant === "portrait" ? this.manifest.portrait : this.manifest.desktop
    this.dataset.worldState = "loading"
    const epoch = this.epoch
    const controller = new AbortController()
    this.download = controller
    const timeout = window.setTimeout(() => controller.abort(), 120000)
    const status = this.querySelector<HTMLElement>("[data-world-status]")
    if (status) status.textContent = "Preparing smooth motion…"
    try {
      const blob = await bufferMotion(
        track.src,
        controller.signal,
        MOTION_VARIANTS[this.variant === "portrait" ? "portrait" : "desktop"].budgetBytes,
        () => {} // Byte progress is intentionally quiet in the live region.
      )
      if (
        epoch !== this.epoch ||
        !this.isConnected ||
        !this.authorized() ||
        document.hidden ||
        !this.near
      )
        return
      this.objectUrl = URL.createObjectURL(blob)
    } catch {
      if (epoch === this.epoch) this.fail()
      return
    } finally {
      clearTimeout(timeout)
      if (this.download === controller) this.download = undefined
    }
    // readyState can change before loadedmetadata is dispatched. Block scroll
    // seeks until the first frame has completed the startup handshake.
    this.priming = true
    this.requested = 0
    // A brief, slow prime makes occluded portrait frames reach the compositor
    // without advancing past the requested frame before it can be acknowledged.
    this.video.defaultPlaybackRate = 0.25
    this.video.src = this.objectUrl
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
    // Register only after load() has reset the media resource. Pause after an
    // actual presented frame, not when the play promise merely resolves.
    this.priming = true
    this.observeFrame()
    this.prime()
  }

  private seeked = () => {
    if (!this.ensureActiveMedia()) return
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
      if (this.ensureActiveMedia()) this.fail()
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
        // A distant anchor/scrollbar jump must not fetch intermediate scenes.
        // Keep easing ordinary wheel/touch movement; seek large jumps directly.
        if (Math.abs(next - this.desired) > 4) this.eased = next
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
    this.requested = target
    this.observeFrame()
    this.video.currentTime = target
    if (!this.deadline) this.armDeadline(2000)
  }

  private observeFrame() {
    if (
      this.presentation ||
      !this.ensureActiveMedia() ||
      !("requestVideoFrameCallback" in this.video)
    )
      return
    const epoch = this.epoch
    this.presentation = this.video.requestVideoFrameCallback((_now, metadata) => {
      // A retired callback must not clear the replacement decoder's handle.
      if (epoch !== this.epoch) return
      this.presentation = 0
      if (!this.ensureActiveMedia()) return
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
          const status = this.querySelector("[data-world-status]")
          if (status) status.textContent = ""
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
    this.cancelScheduled?.()
    this.cancelScheduled = undefined
    cancelAnimationFrame(this.frame)
    this.frame = 0
    this.download?.abort()
    this.download = undefined
    this.clearDeadline()
    if (!this.video) return
    if (this.presentation) this.video.cancelVideoFrameCallback(this.presentation)
    this.presentation = 0
    this.video.pause()
    this.video.removeAttribute("src")
    this.video.preload = "none"
    this.video.load()
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl)
    this.objectUrl = ""
    const status = this.querySelector("[data-world-status]")
    if (status) status.textContent = ""
    this.inFlight = false
    this.priming = false
    delete this.dataset.worldPainted
  }
  private fail = () => {
    this.failed = true
    this.release()
    this.dataset.worldState = "fallback"
    this.toggle.setAttribute("aria-pressed", "false")
    this.querySelector("[data-world-toggle-label]")!.textContent = "Motion unavailable"
    const status = this.querySelector("[data-world-status]")
    if (status)
      status.textContent = "Animation unavailable. The complete evidence story remains available."
  }
  private documentVisibility = () => {
    if (document.hidden) {
      this.release()
      if (this.allowed()) this.dataset.worldState = "poster"
      cancelAnimationFrame(this.frame)
      this.frame = 0
      this.clearDeadline()
    } else {
      this.preference()
      this.queue()
      if (this.allowed() && !this.failed && this.near && (this.inFlight || this.priming))
        this.armDeadline(2000)
    }
  }
}
if (!customElements.get("scroll-world")) customElements.define("scroll-world", ScrollWorld)
