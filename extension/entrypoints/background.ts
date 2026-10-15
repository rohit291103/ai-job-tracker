import { defineBackground } from "wxt/utils/define-background";
import { isCapturePayload, type CapturePayload } from "@shared/capture";
import { getSettings, setLastCapture, type RuntimeMessage } from "@/utils/messages";

/**
 * The only component that talks to the server. Captures arrive here from the
 * relay (automatic) or the popup (manual), and the result is written to storage
 * so the popup can show whether it actually landed.
 */
export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const msg = message as RuntimeMessage | undefined;
    if (!msg || msg.type !== "capture" || !isCapturePayload(msg.payload)) return false;

    // Chrome does not support promise-returning onMessage listeners, so the
    // channel is held open with `return true` and answered via sendResponse.
    void submit(msg.payload)
      .then((detail) => sendResponse({ ok: true, detail }))
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        void setLastCapture({ at: new Date().toISOString(), ok: false, detail });
        sendResponse({ ok: false, detail });
      });
    return true;
  });
});

async function submit(payload: CapturePayload): Promise<string> {
  const { apiBase, token } = await getSettings();
  if (!apiBase || !token) throw new Error("Set the server URL and token in the popup first");

  const response = await fetch(`${apiBase.replace(/\/+$/, "")}/api/capture`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ captures: [payload] }),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);

  // Report the pipeline's own verdict, not just the HTTP status — a 200 with
  // `unparsed` means the capture was stored but could not be attached.
  let detail = "sent";
  try {
    const body = JSON.parse(text) as { counts?: Record<string, number> };
    const counts = body.counts ?? {};
    detail = Object.entries(counts)
      .map(([status, n]) => `${n} ${status}`)
      .join(", ") || "sent";
  } catch {
    // Non-JSON 200 is unexpected but not worth failing the capture over.
  }

  await setLastCapture({ at: new Date().toISOString(), ok: true, detail });
  return detail;
}
