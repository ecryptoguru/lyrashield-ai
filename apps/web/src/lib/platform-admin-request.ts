import { env } from "@lyrashield/config"

const ELEVATION_NONCE = /^[A-Za-z0-9_-]{43}$/

export type PlatformAdminRequestValidation =
  { ok: true; elevationNonce?: string } | { ok: false; code: string; message: string }

export function validatePlatformAdminActionRequest(
  request: Request,
  options: { requireElevationNonce?: boolean; allowedOrigin?: string } = {}
): PlatformAdminRequestValidation {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (contentType !== "application/json") {
    return { ok: false, code: "JSON_REQUIRED", message: "Content-Type must be application/json" }
  }

  if (request.headers.get("sec-fetch-site") !== "same-origin") {
    return { ok: false, code: "SAME_ORIGIN_REQUIRED", message: "Same-origin request required" }
  }

  const origin = request.headers.get("origin")
  let allowedOrigin: string
  try {
    allowedOrigin = new URL(options.allowedOrigin ?? env.NEXT_PUBLIC_APP_URL).origin
  } catch {
    return { ok: false, code: "ORIGIN_CONFIG_INVALID", message: "Server origin is invalid" }
  }
  if (!origin || origin !== allowedOrigin) {
    return { ok: false, code: "ORIGIN_FORBIDDEN", message: "Request origin is not allowed" }
  }

  const elevationNonce = request.headers.get("x-lyrashield-admin-elevation") ?? undefined
  if (options.requireElevationNonce && (!elevationNonce || !ELEVATION_NONCE.test(elevationNonce))) {
    return {
      ok: false,
      code: "ADMIN_ELEVATION_REQUIRED",
      message: "A valid administrator elevation is required",
    }
  }

  return { ok: true, ...(elevationNonce ? { elevationNonce } : {}) }
}
