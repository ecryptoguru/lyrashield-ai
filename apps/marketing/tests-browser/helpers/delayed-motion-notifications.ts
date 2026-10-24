export type DelayedMotionWindow = Window & {
  deliverMotionForTest: () => void
  deadlineForTest?: () => void
}

/** Test-only ordering: the browser preference changes before its notification arrives. */
export function delayMotionNotifications() {
  const state = window as unknown as DelayedMotionWindow
  const notifications: Array<() => void> = []
  const original = window.matchMedia
  window.matchMedia = (query) => {
    const media = original(query)
    if (query.includes("prefers-reduced-motion")) {
      const add = media.addEventListener.bind(media)
      media.addEventListener = ((
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
      ) => {
        if (type !== "change") return add(type, listener, options)
        notifications.push(() => {
          const event = new MediaQueryListEvent("change", { matches: media.matches, media: query })
          if (typeof listener === "function") listener.call(media, event)
          else listener.handleEvent(event)
        })
      }) as typeof media.addEventListener
    }
    return media
  }
  state.deliverMotionForTest = () => notifications.forEach((notify) => notify())
  const timeout = window.setTimeout.bind(window)
  window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (
      delay === 5000 &&
      typeof handler === "function" &&
      document.querySelector("[data-world-video]")?.getAttribute("src") &&
      !state.deadlineForTest
    )
      state.deadlineForTest = () => handler(...args)
    return timeout(handler, delay, ...args)
  }) as typeof window.setTimeout
}
