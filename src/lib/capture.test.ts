import { describe, expect, it } from "vitest";
import {
  atsForHost,
  cleanJobTitle,
  companyNameFromSlug,
  detectAtsPage,
  isCapturePayload,
  isSubmitEndpoint,
} from "./capture";

describe("atsForHost", () => {
  it("matches the host and its subdomains, including regional ones", () => {
    expect(atsForHost("boards.greenhouse.io")).toBe("greenhouse");
    expect(atsForHost("job-boards.eu.greenhouse.io")).toBe("greenhouse");
    expect(atsForHost("jobs.lever.co")).toBe("lever");
    expect(atsForHost("jobs.ashbyhq.com")).toBe("ashby");
  });

  it("is inert off the list, including on lookalike hosts", () => {
    expect(atsForHost("example.com")).toBeNull();
    expect(atsForHost("linkedin.com")).toBeNull();
    // Suffix matching must not accept a domain that merely ends in the text.
    expect(atsForHost("notgreenhouse.io")).toBeNull();
    expect(atsForHost("greenhouse.io.evil.com")).toBeNull();
  });
});

describe("detectAtsPage", () => {
  it("reads employer and job id out of each platform's URL shape", () => {
    expect(detectAtsPage("https://boards.greenhouse.io/acme/jobs/4839201")).toEqual({
      ats: "greenhouse",
      companySlug: "acme",
      jobId: "4839201",
    });
    expect(detectAtsPage("https://jobs.lever.co/acme-corp/a1b2c3d4")).toEqual({
      ats: "lever",
      companySlug: "acme-corp",
      jobId: "a1b2c3d4",
    });
    expect(detectAtsPage("https://jobs.ashbyhq.com/acme/9f8e7d6c")).toEqual({
      ats: "ashby",
      companySlug: "acme",
      jobId: "9f8e7d6c",
    });
  });

  it("returns a null slug for Greenhouse's embedded form, which names no employer", () => {
    expect(detectAtsPage("https://boards.greenhouse.io/embed/job_app?token=12345")).toEqual({
      ats: "greenhouse",
      companySlug: null,
      jobId: null,
    });
  });

  it("still identifies the employer on an application sub-path", () => {
    expect(detectAtsPage("https://jobs.lever.co/acme/a1b2c3d4/apply")?.companySlug).toBe("acme");
    expect(detectAtsPage("https://jobs.ashbyhq.com/acme/9f8e/application")?.companySlug).toBe(
      "acme",
    );
  });

  it("rejects anything that is not an ATS job URL", () => {
    expect(detectAtsPage("https://boards.greenhouse.io/")).toBeNull();
    expect(detectAtsPage("https://example.com/acme/jobs/1")).toBeNull();
    expect(detectAtsPage("not a url")).toBeNull();
    expect(detectAtsPage("javascript:alert(1)")).toBeNull();
  });
});

describe("companyNameFromSlug", () => {
  it("makes a slug readable", () => {
    expect(companyNameFromSlug("acme")).toBe("Acme");
    expect(companyNameFromSlug("acme-corp")).toBe("Acme Corp");
    expect(companyNameFromSlug("acme_labs")).toBe("Acme Labs");
  });

  it("passes null through", () => {
    expect(companyNameFromSlug(null)).toBeNull();
    expect(companyNameFromSlug("")).toBeNull();
  });
});

describe("cleanJobTitle", () => {
  it("strips Greenhouse's page-title wrapper", () => {
    expect(cleanJobTitle("Job Application for Senior Engineer at Acme", "Acme")).toBe(
      "Senior Engineer",
    );
  });

  it("strips the company from either side, whatever the separator", () => {
    expect(cleanJobTitle("Senior Engineer - Acme", "Acme")).toBe("Senior Engineer");
    expect(cleanJobTitle("Senior Engineer | Acme", "Acme")).toBe("Senior Engineer");
    expect(cleanJobTitle("Senior Engineer @ Acme", "Acme")).toBe("Senior Engineer");
    expect(cleanJobTitle("Acme - Senior Engineer", "Acme")).toBe("Senior Engineer");
  });

  it("keeps a separator that is part of the role when the company is unknown", () => {
    // "Engineer - Backend" is as likely as "Engineer - Bangalore", so cutting
    // blind would throw away real title text. Same rule as normalizeTitle.
    expect(cleanJobTitle("Engineer - Backend", null)).toBe("Engineer - Backend");
  });

  it("does not cut a company name that appears mid-title", () => {
    expect(cleanJobTitle("Acme Platform Engineer", "Acme")).toBe("Acme Platform Engineer");
  });

  it("treats regex characters in a company name as literal text", () => {
    expect(cleanJobTitle("Engineer - C++ (Pty) Ltd.", "C++ (Pty) Ltd.")).toBe("Engineer");
  });

  it("returns null when nothing is left", () => {
    expect(cleanJobTitle("   ", "Acme")).toBeNull();
    expect(cleanJobTitle("Acme", "Acme")).toBeNull();
  });
});

describe("isSubmitEndpoint", () => {
  it("accepts a POST to an application path on a known ATS host", () => {
    expect(isSubmitEndpoint("https://boards.greenhouse.io/acme/applications", "POST")).toBe(true);
    expect(isSubmitEndpoint("https://jobs.lever.co/acme/a1b2/apply", "post")).toBe(true);
    expect(isSubmitEndpoint("https://boards.greenhouse.io/embed/job_app", "POST")).toBe(true);
  });

  it("ignores reads, so merely loading a page captures nothing", () => {
    expect(isSubmitEndpoint("https://boards.greenhouse.io/acme/applications", "GET")).toBe(false);
  });

  it("ignores POSTs that are not application submissions", () => {
    expect(isSubmitEndpoint("https://boards.greenhouse.io/acme/analytics", "POST")).toBe(false);
  });

  it("never fires off an ATS host, whatever the path looks like", () => {
    expect(isSubmitEndpoint("https://example.com/apply", "POST")).toBe(false);
  });
});

describe("isCapturePayload", () => {
  const valid = {
    captureId: "11111111-2222-3333-4444-555555555555",
    trigger: "manual",
    url: "https://boards.greenhouse.io/acme/jobs/1",
    ats: "greenhouse",
    company: "Acme",
    title: "Senior Engineer",
    capturedAt: "2026-10-15T09:00:00.000Z",
  };

  it("accepts a well-formed payload, with the optional fields absent or null", () => {
    expect(isCapturePayload(valid)).toBe(true);
    expect(isCapturePayload({ ...valid, company: null, title: null, jobDescription: null })).toBe(
      true,
    );
  });

  it("rejects a payload missing its idempotency key", () => {
    expect(isCapturePayload({ ...valid, captureId: "" })).toBe(false);
    const { captureId: _omitted, ...without } = valid;
    expect(isCapturePayload(without)).toBe(false);
  });

  it("rejects an unknown trigger and an unparseable timestamp", () => {
    expect(isCapturePayload({ ...valid, trigger: "guess" })).toBe(false);
    expect(isCapturePayload({ ...valid, capturedAt: "whenever" })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isCapturePayload(null)).toBe(false);
    expect(isCapturePayload("x")).toBe(false);
  });
});
