import { defineContentScript } from "wxt/utils/define-content-script";
import { injectScript } from "wxt/utils/inject-script";
import { companyNameFromSlug, cleanJobTitle, detectAtsPage, type CapturePayload } from "@shared/capture";
import { PAGE_MARKER, type PageMessage, type RuntimeMessage } from "@/utils/messages";
import { collectPageMeta } from "@/utils/page";

/**
 * Isolated-world half of the capture pair.
 *
 * The interceptor has to run in the page's context to patch window.fetch, and a
 * MAIN-world script cannot reach the extension APIs — so this script injects it
 * and relays what it reports on to the background worker. WXT recommends
 * injectScript over a `world: "MAIN"` content script for exactly this reason.
 *
 * On the injection race: the script tag loads asynchronously, so the patch is
 * not guaranteed to be in place before the page's first request. That is
 * acceptable here because a submission happens when the user clicks submit,
 * seconds or minutes after load, long after the patch has landed. It would not
 * be acceptable for capturing requests made during page load.
 */
export default defineContentScript({
  matches: ["https://*.greenhouse.io/*", "https://*.lever.co/*", "https://*.ashbyhq.com/*"],
  runAt: "document_start",

  async main() {
    await injectScript("/interceptor.js");

    window.addEventListener("message", (event) => {
      // Only trust this frame's own context: anything cross-origin, or from a
      // nested iframe, is not the page we injected into.
      if (event.source !== window || event.origin !== location.origin) return;

      const data = event.data as PageMessage | undefined;
      if (!data || data.marker !== PAGE_MARKER) return;

      void send(buildPayload("intercept"));
    });
  },
});

function buildPayload(trigger: CapturePayload["trigger"]): CapturePayload {
  const meta = collectPageMeta();
  const page = detectAtsPage(meta.url);
  const company = companyNameFromSlug(page?.companySlug ?? null);

  return {
    captureId: crypto.randomUUID(),
    trigger,
    url: meta.url,
    ats: page?.ats ?? null,
    company,
    title: cleanJobTitle(meta.title, company),
    capturedAt: new Date().toISOString(),
    jobDescription: meta.jobDescription,
  };
}

async function send(payload: CapturePayload): Promise<void> {
  const message: RuntimeMessage = { type: "capture", payload };
  try {
    await browser.runtime.sendMessage(message);
  } catch {
    // The worker may have been torn down; the popup surfaces the last result.
  }
}
