import type { CapturePayload } from "@shared/capture";

/** Marker on window.postMessage traffic between the page and the relay. */
export const PAGE_MARKER = "job-tracker:submit" as const;

export type PageMessage = {
  marker: typeof PAGE_MARKER;
  url: string;
  method: string;
};

export type RuntimeMessage = { type: "capture"; payload: CapturePayload };

export type Settings = { apiBase: string; token: string };

/** Shown in the popup so a silent failure is visible rather than assumed to have worked. */
export type LastCapture = { at: string; ok: boolean; detail: string };

export async function getSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(["apiBase", "token"]);
  return {
    apiBase: typeof stored.apiBase === "string" ? stored.apiBase : "",
    token: typeof stored.token === "string" ? stored.token : "",
  };
}

export async function setLastCapture(last: LastCapture): Promise<void> {
  await browser.storage.local.set({ lastCapture: last });
}

export async function getLastCapture(): Promise<LastCapture | null> {
  const stored = await browser.storage.local.get("lastCapture");
  const last = stored.lastCapture;
  if (typeof last !== "object" || last === null) return null;
  const l = last as Record<string, unknown>;
  return typeof l.at === "string" && typeof l.ok === "boolean" && typeof l.detail === "string"
    ? { at: l.at, ok: l.ok, detail: l.detail }
    : null;
}
