import { resolve } from "node:path";
import { defineConfig } from "wxt";

/**
 * WXT config for the capture extension (ADR-002, ARCHITECTURE.md section 10).
 *
 * `@shared` points at the Next app's src/lib, which is the point of running one
 * TypeScript project: src/lib/capture.ts is the single definition of the
 * payload contract and the URL patterns, imported by both sides. It cannot be
 * `@` or `~` — WXT reserves both for its own srcDir.
 */
const ATS_MATCHES = [
  "https://*.greenhouse.io/*",
  "https://*.lever.co/*",
  "https://*.ashbyhq.com/*",
];

export default defineConfig({
  srcDir: "extension",
  manifest: {
    name: "Job Tracker Capture",
    description: "Records job applications as you submit them.",
    version: "0.1.0",
    /**
     * `activeTab` rather than broad host access: the manual save button reads
     * the page only on an explicit click, and automatic capture is confined to
     * the three ATS hosts below. Nothing else is ever readable.
     */
    permissions: ["storage", "activeTab", "scripting"],
    host_permissions: ATS_MATCHES,
    web_accessible_resources: [{ resources: ["interceptor.js"], matches: ATS_MATCHES }],
  },
  vite: () => ({
    resolve: { alias: { "@shared": resolve(__dirname, "src/lib") } },
  }),
});
