/**
 * Google Calendar adapter — founder-only OAuth for ankit@lyrashieldai.com.
 * Throws CALENDAR_NOT_CONFIGURED unless MYRA_GOOGLE_CLIENT_* envs exist.
 * Tokens stay server-side; nothing here is reachable from the client bundle.
 */
import { MyraServiceError } from "../errors"
import {
  CalendarTimeoutError,
  type BusyWindow,
  type CalendarAdapter,
  type CalendarEventResult,
  type CalendarEventSpec,
} from "./adapter"

interface GoogleEnv {
  clientId: string
  clientSecret: string
  refreshToken: string
  calendarId: string
}

function googleEnv(): GoogleEnv | null {
  const clientId = process.env.MYRA_GOOGLE_CLIENT_ID
  const clientSecret = process.env.MYRA_GOOGLE_CLIENT_SECRET
  // Dev convenience: a full OAuth token blob can stand in for the refresh env.
  let refreshToken = process.env.MYRA_GOOGLE_REFRESH_TOKEN
  if (!refreshToken && process.env.MYRA_GOOGLE_TOKEN_JSON) {
    try {
      const blob = JSON.parse(process.env.MYRA_GOOGLE_TOKEN_JSON) as {
        refresh_token?: string
      }
      refreshToken = blob.refresh_token
    } catch {
      refreshToken = undefined
    }
  }
  if (!clientId || !clientSecret || !refreshToken) return null
  return {
    clientId,
    clientSecret,
    refreshToken,
    calendarId: process.env.MYRA_GOOGLE_CALENDAR_ID ?? "primary",
  }
}

let cachedToken: { token: string; expiresAt: number } | null = null

async function accessToken(env: GoogleEnv): Promise<string> {
  // Refresh tokens mint 1-hour access tokens; cache with a 5-minute margin so
  // each calendar call doesn't pay a token round-trip.
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5 * 60_000) {
    return cachedToken.token
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.clientId,
      client_secret: env.clientSecret,
      refresh_token: env.refreshToken,
      grant_type: "refresh_token",
    }),
  })
  if (!res.ok) throw new MyraServiceError("PROVIDER_ERROR", "Calendar auth failed.")
  const body = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!body.access_token) throw new MyraServiceError("PROVIDER_ERROR", "Calendar auth failed.")
  cachedToken = {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  }
  return body.access_token
}

async function api(env: GoogleEnv, path: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken(env)
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.calendarId)}${path}`,
    {
      ...init,
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...init.headers,
      },
    }
  )
  return res
}

export class GoogleCalendarAdapter implements CalendarAdapter {
  name = "google"

  private env(): GoogleEnv {
    const env = googleEnv()
    if (!env) {
      throw new MyraServiceError("CALENDAR_NOT_CONFIGURED", "Google Calendar is not configured.")
    }
    return env
  }

  async listBusy(from: Date, to: Date): Promise<BusyWindow[]> {
    const env = this.env()
    const res = await api(env, `:freeBusy?alt=json`, {
      method: "POST",
      body: JSON.stringify({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        items: [{ id: env.calendarId }],
      }),
    }).catch((e) => {
      throw e instanceof MyraServiceError ? e : new CalendarTimeoutError()
    })
    if (!res.ok) throw new MyraServiceError("PROVIDER_ERROR", "Calendar free/busy failed.")
    const body = (await res.json()) as {
      calendars?: Record<string, { busy?: { start: string; end: string }[] }>
    }
    return (body.calendars?.[env.calendarId]?.busy ?? []).map((b) => ({
      start: new Date(b.start),
      end: new Date(b.end),
    }))
  }

  async insertEvent(spec: CalendarEventSpec): Promise<CalendarEventResult> {
    const env = this.env()
    const res = await api(env, `/events?conferenceDataVersion=1&sendUpdates=all`, {
      method: "POST",
      body: JSON.stringify({
        id: spec.eventId,
        summary: spec.summary,
        description: spec.description,
        start: { dateTime: spec.start.toISOString() },
        end: { dateTime: spec.end.toISOString() },
        attendees: [{ email: spec.attendeeEmail, displayName: spec.attendeeName }],
        organizer: { email: spec.organizerEmail },
        ...(spec.requestMeet
          ? {
              conferenceData: {
                createRequest: {
                  requestId: spec.conferenceRequestId,
                  conferenceSolutionKey: { type: "hangoutsMeet" },
                },
              },
            }
          : {}),
      }),
    }).catch((e) => {
      throw e instanceof MyraServiceError ? e : new CalendarTimeoutError()
    })
    if (res.status === 409) {
      // Deterministic id already exists — fetch it (timeout reconciliation).
      const existing = await this.getEvent(spec.eventId)
      if (existing) return existing
      throw new MyraServiceError("PROVIDER_ERROR", "Calendar event conflict.")
    }
    if (!res.ok) throw new MyraServiceError("PROVIDER_ERROR", "Calendar insert failed.")
    return mapEvent(spec.eventId, (await res.json()) as Record<string, unknown>)
  }

  async cancelEvent(eventId: string): Promise<void> {
    const env = this.env()
    const res = await api(env, `/events/${encodeURIComponent(eventId)}?sendUpdates=all`, {
      method: "DELETE",
    }).catch((e) => {
      throw e instanceof MyraServiceError ? e : new CalendarTimeoutError()
    })
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      throw new MyraServiceError("PROVIDER_ERROR", "Calendar cancel failed.")
    }
  }

  async getEvent(eventId: string): Promise<CalendarEventResult | null> {
    const env = this.env()
    const res = await api(env, `/events/${encodeURIComponent(eventId)}`).catch((e) => {
      throw e instanceof MyraServiceError ? e : new CalendarTimeoutError()
    })
    if (res.status === 404 || res.status === 410) return null
    if (!res.ok) throw new MyraServiceError("PROVIDER_ERROR", "Calendar read failed.")
    const body = (await res.json()) as Record<string, unknown>
    if (body.status === "cancelled") return null
    return mapEvent(eventId, body)
  }
}

function mapEvent(eventId: string, body: Record<string, unknown>): CalendarEventResult {
  const conference = body.conferenceData as
    | { entryPoints?: { entryPointType: string; uri: string }[]; status?: { statusCode?: string } }
    | undefined
  const meetLink =
    conference?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ??
    (typeof body.hangoutLink === "string" ? body.hangoutLink : null)
  const conferenceState = conference
    ? conference.status?.statusCode === "pending"
      ? "pending"
      : meetLink
        ? "ready"
        : "pending"
    : "none"
  return { eventId, meetLink, conferenceState }
}
