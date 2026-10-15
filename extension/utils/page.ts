/**
 * Page metadata collection.
 *
 * `collectPageMeta` is passed to browser.scripting.executeScript, which
 * serializes the function and runs it in the page. It therefore cannot
 * reference anything outside its own body — no imports, no module constants.
 * Keep it self-contained.
 */
export type PageMeta = {
  url: string;
  title: string;
  jobDescription: string | null;
};

export function collectPageMeta(): PageMeta {
  const SELECTORS = [
    "#content",
    "#job_description",
    ".job__description",
    '[data-qa="job-description"]',
    ".posting-page",
    "main",
    "article",
  ];
  const MIN_LENGTH = 200;
  const MAX_LENGTH = 20000;

  let description: string | null = null;
  for (const selector of SELECTORS) {
    const el = document.querySelector(selector);
    const text = el instanceof HTMLElement ? el.innerText.trim() : "";
    if (text.length >= MIN_LENGTH) {
      description = text.slice(0, MAX_LENGTH);
      break;
    }
  }
  if (description === null) {
    const body = document.body?.innerText?.trim() ?? "";
    description = body.length >= MIN_LENGTH ? body.slice(0, MAX_LENGTH) : null;
  }

  // og:title is usually the role on its own, where document.title wraps it.
  const og = document
    .querySelector('meta[property="og:title"]')
    ?.getAttribute("content")
    ?.trim();

  return {
    url: location.href,
    title: og && og.length > 0 ? og : document.title,
    jobDescription: description,
  };
}
