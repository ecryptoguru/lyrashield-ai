import { config } from "dotenv"
import { resolve } from "path"
import { defineConfig, env } from "prisma/config"

config({ path: resolve(__dirname, "../../.env") })

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.DATABASE_DIRECT_URL || env("DATABASE_URL"),
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
})
