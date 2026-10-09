import { describe, expect, it } from "vitest";
import { matchTemplate, type InboundEmail } from "./templates";

const email = (over: Partial<InboundEmail>): InboundEmail => ({
  messageId: "m1",
  threadId: "t1",
  from: "someone@example.com",
  to: "me@example.com",
  subject: "",
  date: "2026-10-09T00:00:00.000Z",
  body: "",
  ...over,
});

describe("ATS confirmations", () => {
  it("parses a Greenhouse confirmation from a display-name sender", () => {
    const m = matchTemplate(
      email({
        from: "Acme Careers <no-reply@greenhouse.io>",
        subject: "Thank you for applying to Acme Inc.",
      }),
    );
    expect(m).toMatchObject({
      ats: "greenhouse",
      company: "Acme Inc",
      eventType: "applied",
      matchedBy: "greenhouse.confirmation",
    });
  });

  it("matches ATS subdomains", () => {
    const m = matchTemplate(
      email({
        from: "no-reply@us.greenhouse-mail.io",
        subject: "Your application to Globex",
      }),
    );
    expect(m?.ats).toBe("greenhouse");
    expect(m?.company).toBe("Globex");
  });

  it("parses LinkedIn Easy Apply", () => {
    const m = matchTemplate(
      email({
        from: "LinkedIn <jobs-noreply@linkedin.com>",
        subject: "Your application was sent to Acme",
      }),
    );
    expect(m).toMatchObject({ ats: "linkedin", company: "Acme", eventType: "applied" });
  });

  it("parses title and company out of an Indeed confirmation", () => {
    const m = matchTemplate(
      email({
        from: "indeedapply@indeed.com",
        subject: "You applied to Senior Product Manager at Acme",
      }),
    );
    expect(m).toMatchObject({
      ats: "indeed",
      title: "Senior Product Manager",
      company: "Acme",
      eventType: "applied",
    });
  });

  it("emits `applied`, not `confirmation_received`", () => {
    // For anything the extension did not capture, this email *is* how the
    // application is discovered, so it has to be the status-bearing event.
    const m = matchTemplate(
      email({ from: "no-reply@ashbyhq.com", subject: "Thank you for applying to Initech" }),
    );
    expect(m?.eventType).toBe("applied");
  });
});

describe("Naukri noise filtering", () => {
  it("ignores job alerts and mailers despite the sender matching", () => {
    // Naukri sends very high volumes of non-application mail. A false positive
    // invents an application that does not exist, which is worse than a miss.
    for (const subject of [
      "15 new jobs matching your profile",
      "Recruiters are looking for you",
      "Your profile was viewed 7 times this week",
    ]) {
      expect(matchTemplate(email({ from: "alerts@naukri.com", subject }))).toBeNull();
    }
  });

  it("matches an actual Naukri application confirmation", () => {
    const m = matchTemplate(
      email({ from: "no-reply@naukri.com", subject: "Your application has been sent to Acme" }),
    );
    expect(m).toMatchObject({ ats: "naukri", company: "Acme", eventType: "applied" });
  });
});

describe("content rules for follow-up mail", () => {
  it("detects a rejection from a company sender", () => {
    const m = matchTemplate(
      email({
        from: "Jane Doe <jane@acme.com>",
        subject: "Update on your application",
        body: "Thank you for your time. Unfortunately, we have decided to move forward with other candidates.",
      }),
    );
    expect(m).toMatchObject({ eventType: "rejected", matchedBy: "content.rejected", ats: null });
  });

  it("detects an assessment", () => {
    const m = matchTemplate(
      email({
        from: "recruiting@globex.com",
        subject: "Next step",
        body: "Please complete the HackerRank assessment within 72 hours.",
      }),
    );
    expect(m?.eventType).toBe("assessment_sent");
  });

  it("detects an interview invitation", () => {
    const m = matchTemplate(
      email({
        from: "recruiting@globex.com",
        subject: "Chat?",
        body: "We would love to schedule a 30 minute call next week.",
      }),
    );
    expect(m?.eventType).toBe("interview_invite");
  });

  it("lets rejection win over interview language in the same message", () => {
    // Order is load-bearing: a post-interview rejection mentions the interview,
    // and matching the invite rule would walk the status backwards.
    const m = matchTemplate(
      email({
        from: "jane@acme.com",
        subject: "Your interview",
        body: "Following your interview, unfortunately we have decided to move forward with other candidates.",
      }),
    );
    expect(m?.eventType).toBe("rejected");
  });

  it("detects an offer", () => {
    const m = matchTemplate(
      email({
        from: "jane@acme.com",
        subject: "Good news",
        body: "We are pleased to extend an offer of employment.",
      }),
    );
    expect(m?.eventType).toBe("offer");
  });
});

describe("falling through to the model", () => {
  it("returns null for unrelated mail rather than guessing", () => {
    expect(
      matchTemplate(
        email({
          from: "newsletter@substack.com",
          subject: "This week in tech",
          body: "Here are the top stories from the week.",
        }),
      ),
    ).toBeNull();
  });

  it("returns null for an ATS sender whose subject it does not recognize", () => {
    expect(
      matchTemplate(
        email({
          from: "no-reply@greenhouse.io",
          subject: "A subject this parser has never seen",
          body: "Some body text.",
        }),
      ),
    ).toBeNull();
  });
});
