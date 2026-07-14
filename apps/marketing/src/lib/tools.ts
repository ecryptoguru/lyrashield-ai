export const tools = [
  {
    slug: "ai-app-security-checklist",
    title: "AI App Launch Security Checklist",
    description: "Prioritize the security checks that matter before an AI-built app ships.",
    privacy: "No code or target data is collected.",
    category: "Check before launch",
  },
  {
    slug: "security-headers-checker",
    title: "Security Headers and CORS Checker",
    description: "Review pasted response headers locally for common browser-security gaps.",
    privacy: "Headers stay in your browser.",
    category: "Check before launch",
  },
  {
    slug: "secret-exposure-scanner",
    title: "Secret Exposure Scanner",
    description:
      "Scan selected local files for high-confidence secret patterns without uploading them.",
    privacy: "Files never leave your device.",
    category: "Protect data and access",
  },
  {
    slug: "supabase-rls-checker",
    title: "Supabase RLS Policy Checker",
    description: "Spot risky RLS policy patterns in pasted SQL before you deploy.",
    privacy: "SQL stays in your browser.",
    category: "Protect data and access",
  },
  {
    slug: "jwt-session-inspector",
    title: "JWT and Session Inspector",
    description: "Decode a token locally and review claims and session-cookie guidance.",
    privacy: "Tokens are decoded locally and are never verified or sent.",
    category: "Protect data and access",
  },
] as const

export type Tool = (typeof tools)[number]

export function toolUrl(slug: Tool["slug"]): string {
  return `/tools/${slug}`
}
