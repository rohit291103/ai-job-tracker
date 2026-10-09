import type { Config } from "drizzle-kit";

// The SQL in supabase/migrations/ is the source of truth and is applied to
// Supabase directly. Drizzle is used for typed queries and for generating
// future migrations; `drizzle-kit push` is deliberately not part of any
// deploy flow, so the two can't drift silently in opposite directions.
export default {
  schema: "./src/db/schema.ts",
  out: "./supabase/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
  verbose: true,
  strict: true,
} satisfies Config;
