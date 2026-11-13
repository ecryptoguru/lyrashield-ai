export interface ZonedParts {
  date: string // YYYY-MM-DD
  weekday: string // Mon..Sun
  minutes: number // minutes since local midnight
}

const partsCache = new Map<string, Intl.DateTimeFormat>()

function formatter(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      weekday: "short",
    })
    partsCache.set(tz, f)
  }
  return f
}

export function zonedParts(instant: Date, tz: string): ZonedParts {
  const parts = formatter(tz).formatToParts(instant)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ""
  const hour = get("hour") === "24" ? "00" : get("hour")
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: get("weekday"),
    minutes: Number(hour) * 60 + Number(get("minute")),
  }
}

/** Convert a wall-clock time in `tz` to the corresponding UTC instant. */
export function zonedWallToUtc(date: string, minutes: number, tz: string): Date {
  let guess = Date.parse(`${date}T00:00:00Z`) + minutes * 60_000
  const target = guess
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), tz)
    const wall = Date.parse(`${p.date}T00:00:00Z`) + p.minutes * 60_000
    const diff = target - wall
    if (diff === 0) break
    guess += diff
  }
  return new Date(guess)
}
