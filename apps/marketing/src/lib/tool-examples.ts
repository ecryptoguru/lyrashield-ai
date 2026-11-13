/** Synthetic browser-local fixtures. Never credentials for a real account. */
const exampleJwtHeader = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
const exampleJwtPayload = btoa(JSON.stringify({ sub: "example-user", exp: 4_102_444_800 }))

export const TOOL_EXAMPLES = {
  headers:
    "Content-Security-Policy: default-src 'self'; frame-ancestors 'none'\nStrict-Transport-Security: max-age=31536000\nX-Content-Type-Options: nosniff\nReferrer-Policy: no-referrer\nPermissions-Policy: camera=(), microphone=(), geolocation=()",
  sql: "alter table public.projects enable row level security;\nalter table public.projects force row level security;\ncreate policy owner_access on public.projects\n  using (auth.uid() = user_id)\n  with check (auth.uid() = user_id);",
  jwt: [exampleJwtHeader, exampleJwtPayload, "synthetic-signature"].join("."),
  cookie: "demo=synthetic; Secure; HttpOnly; SameSite=Lax",
} as const
