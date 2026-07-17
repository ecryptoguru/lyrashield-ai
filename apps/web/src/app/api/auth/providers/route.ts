import { NextResponse } from "next/server"
import { env } from "@lyrashield/config"

export async function GET() {
  return NextResponse.json({
    github: Boolean(env.GITHUB_CLIENT_ID),
    microsoft: Boolean(env.AZURE_AD_CLIENT_ID),
  })
}
