import { config } from "dotenv"
import { resolve } from "path"
import { defineConfig, env } from "prisma/config"

config({ path: resolve(__dirname, "../../.env"), quiet: true })

const isClientGeneration = process.argv.includes("generate")
const databaseUrl =
  process.env.DATABASE_DIRECT_URL ||
  process.env.DATABASE_URL ||
  (isClientGeneration ? "postgresql://localhost:5432/lyrashield_generate" : env("DATABASE_URL"))

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: databaseUrl,
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
})
