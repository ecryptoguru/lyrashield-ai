import { NextResponse } from "next/server"
import { protectedResourceMetadata } from "@/lib/oauth-resource-metadata"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  return NextResponse.json(await protectedResourceMetadata(), {
    headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
  })
}
