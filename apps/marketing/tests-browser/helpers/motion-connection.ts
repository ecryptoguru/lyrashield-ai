/** A supplied connection hint for decoder contracts, not a bandwidth measurement. */
export function fastMotionConnection() {
  Object.defineProperty(navigator, "connection", {
    configurable: true,
    value: Object.assign(new EventTarget(), { effectiveType: "4g", downlink: 10, saveData: false }),
  })
}
