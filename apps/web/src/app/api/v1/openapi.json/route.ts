import { NextResponse } from "next/server"
import { buildOpenApiSpec } from "@lyrashield/types/openapi"

export async function GET() {
  return NextResponse.json(buildOpenApiSpec(), {
    headers: { "Content-Type": "application/json" },
  })
}
