import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the pure logic is unit tested here: normalization and template
    // matching. Anything touching the database belongs in an integration suite
    // against a throwaway Postgres, not against the live project.
    include: ["src/**/*.test.ts"],
  },
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
});
