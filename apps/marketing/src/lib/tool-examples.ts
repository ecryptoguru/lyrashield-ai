/** Synthetic browser-local fixtures. Never credentials for a real account. */
export const TOOL_EXAMPLES = {
  headers:
    "Content-Security-Policy: default-src 'self'; frame-ancestors 'none'\nStrict-Transport-Security: max-age=31536000\nX-Content-Type-Options: nosniff\nReferrer-Policy: no-referrer\nPermissions-Policy: camera=(), microphone=(), geolocation=()",
  sql: "alter table public.projects enable row level security;\nalter table public.projects force row level security;\ncreate policy owner_access on public.projects\n  using (auth.uid() = user_id)\n  with check (auth.uid() = user_id);",
  jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJleGFtcGxlLXVzZXIiLCJleHAiOjQxMDI0NDQ4MDB9.synthetic-signature",
  cookie: "demo=synthetic; Secure; HttpOnly; SameSite=Lax",
} as const
