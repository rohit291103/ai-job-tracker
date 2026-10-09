import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

let instance: Db | null = null;

/**
 * Lazily constructed so importing this module does not require DATABASE_URL.
 * Next.js evaluates module graphs at build time, and a connection attempt
 * during the build would fail there rather than at the point of use.
 */
function connect(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  // prepare: false is required for Supabase's transaction-mode pooler (6543),
  // which does not support prepared statements.
  return drizzle(postgres(url, { prepare: false }), { schema });
}

export const db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    instance ??= connect();
    return Reflect.get(instance, prop, receiver);
  },
});

export { schema };
