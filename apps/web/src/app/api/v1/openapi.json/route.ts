import { NextResponse } from "next/server"
import { buildOpenApiSpec } from "../../../../lib/openapi/build"

export async function GET() {
  return NextResponse.json(buildOpenApiSpec(), {
    headers: { "Content-Type": "application/json" },
  })
}
