import {
  cleanJobTitle,
  companyNameFromSlug,
  detectAtsPage,
  type CapturePayload,
} from "@shared/capture";
import { getLastCapture, getSettings, type RuntimeMessage } from "@/utils/messages";
import { collectPageMeta } from "@/utils/page";

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const saveButton = el<HTMLButtonElement>("save");
const statusLine = el<HTMLParagraphElement>("status");
const apiBaseInput = el<HTMLInputElement>("apiBase");
const tokenInput = el<HTMLInputElement>("token");

function show(text: string, isError = false): void {
  statusLine.textContent = text;
  statusLine.classList.toggle("error", isError);
}

async function init(): Promise<void> {
  const settings = await getSettings();
  apiBaseInput.value = settings.apiBase;
  tokenInput.value = settings.token;

  if (!settings.apiBase || !settings.token) {
    el<HTMLDetailsElement>("settings").open = true;
    show("Set the server URL and token to start.");
    return;
  }

  const last = await getLastCapture();
  if (last) {
    const when = new Date(last.at).toLocaleString();
    show(last.ok ? `Last capture: ${last.detail} (${when})` : `Last error: ${last.detail}`, !last.ok);
  }
}

el<HTMLButtonElement>("saveSettings").addEventListener("click", async () => {
  await browser.storage.local.set({
    apiBase: apiBaseInput.value.trim(),
    token: tokenInput.value,
  });
  show("Settings saved.");
});

/**
 * Manual capture. Reads the page through scripting.executeScript rather than a
 * content script, so it works on any site — Workday, a company careers page,
 * anywhere the ATS-specific scripts don't run. `activeTab` grants that access
 * only because of this click.
 */
saveButton.addEventListener("click", async () => {
  saveButton.disabled = true;
  show("Capturing…");
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab");

    const [result] = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectPageMeta,
    });
    const meta = result?.result;
    if (!meta) throw new Error("Could not read the page");

    const page = detectAtsPage(meta.url);
    const company = companyNameFromSlug(page?.companySlug ?? null);
    const payload: CapturePayload = {
      captureId: crypto.randomUUID(),
      trigger: "manual",
      url: meta.url,
      ats: page?.ats ?? null,
      company,
      title: cleanJobTitle(meta.title, company),
      capturedAt: new Date().toISOString(),
      jobDescription: meta.jobDescription,
    };

    const message: RuntimeMessage = { type: "capture", payload };
    const response = (await browser.runtime.sendMessage(message)) as
      | { ok: boolean; detail: string }
      | undefined;

    if (!response) show("No response from the extension worker.", true);
    else show(response.ok ? `Saved: ${response.detail}` : response.detail, !response.ok);
  } catch (err) {
    show(err instanceof Error ? err.message : String(err), true);
  } finally {
    saveButton.disabled = false;
  }
});

void init();
