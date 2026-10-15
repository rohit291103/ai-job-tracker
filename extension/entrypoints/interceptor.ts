import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";
import { isSubmitEndpoint } from "@shared/capture";
import { PAGE_MARKER, type PageMessage } from "@/utils/messages";

/**
 * Runs in the page's own JS context, injected by relay.content.ts.
 *
 * Why the network layer and not the DOM: ARCHITECTURE.md section 3. These are
 * SPAs whose markup changes often and whose submit request does not.
 *
 * It only ever reports that a submission happened, plus its URL and method. It
 * does not read or forward the request body — that would mean handling names,
 * addresses and answers for no gain, since the server derives everything it
 * needs from the page metadata the relay collects.
 */
export default defineUnlistedScript(() => {
  const announce = (url: string, method: string) => {
    const message: PageMessage = { marker: PAGE_MARKER, url, method };
    window.postMessage(message, location.origin);
  };

  const originalFetch = window.fetch;
  window.fetch = async function patchedFetch(this: unknown, ...args: Parameters<typeof fetch>) {
    const response = await originalFetch.apply(this as never, args);
    try {
      const [input, init] = args;
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      // 2xx only: a rejected submission is not an application.
      if (response.ok && isSubmitEndpoint(new URL(url, location.href).href, method)) {
        announce(new URL(url, location.href).href, method);
      }
    } catch {
      // Never let instrumentation break the page's own request.
    }
    return response;
  };

  // Some ATS front-ends still submit over XHR.
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const seen = new WeakMap<XMLHttpRequest, { url: string; method: string }>();

  XMLHttpRequest.prototype.open = function patchedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    try {
      seen.set(this, { url: new URL(String(url), location.href).href, method });
    } catch {
      // Ignore an unparseable URL; the request itself still proceeds below.
    }
    return (originalOpen as (...a: unknown[]) => void).apply(this, [method, url, ...rest]);
  } as typeof XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.send = function patchedSend(
    this: XMLHttpRequest,
    ...args: Parameters<XMLHttpRequest["send"]>
  ) {
    const request = seen.get(this);
    if (request) {
      this.addEventListener("load", () => {
        try {
          if (this.status >= 200 && this.status < 300 && isSubmitEndpoint(request.url, request.method)) {
            announce(request.url, request.method);
          }
        } catch {
          // As above.
        }
      });
    }
    return originalSend.apply(this, args);
  };
});
