import { describe, expect, it } from "vitest";
import {
  buildFunnel,
  buildResponseTimes,
  buildSources,
  effectiveStatus,
  type ApplicationFact,
  type Status,
} from "./insights";

const NOW = new Date("2026-10-14T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function fact(over: Partial<ApplicationFact> = {}): ApplicationFact {
  return {
    id: crypto.randomUUID(),
    ats: null,
    appliedAt: daysAgo(30),
    currentStatus: "applied" satisfies Status,
    peakStage: 1,
    lastEventAt: daysAgo(30),
    firstResponseAt: null,
    ...over,
  };
}

describe("effectiveStatus", () => {
  it("reads an early-stage application with no recent event as ghosted", () => {
    const f = fact({ currentStatus: "applied", lastEventAt: daysAgo(20) });
    expect(effectiveStatus(f, 14, NOW)).toBe("ghosted");
  });

  it("leaves an application inside the threshold alone", () => {
    const f = fact({ currentStatus: "applied", lastEventAt: daysAgo(10) });
    expect(effectiveStatus(f, 14, NOW)).toBe("applied");
  });

  it("does not ghost exactly at the threshold", () => {
    const f = fact({ currentStatus: "applied", lastEventAt: daysAgo(14) });
    expect(effectiveStatus(f, 14, NOW)).toBe("applied");
  });

  it("never ghosts a status past the early stages, however long the silence", () => {
    for (const status of ["screening", "assessment", "interview", "offer"] as const) {
      const f = fact({ currentStatus: status, lastEventAt: daysAgo(400) });
      expect(effectiveStatus(f, 14, NOW)).toBe(status);
    }
  });

  it("never overwrites a decided outcome", () => {
    for (const status of ["rejected", "withdrawn"] as const) {
      const f = fact({ currentStatus: status, lastEventAt: daysAgo(400) });
      expect(effectiveStatus(f, 14, NOW)).toBe(status);
    }
  });

  it("falls back to the application date when there are no events", () => {
    const f = fact({ lastEventAt: null, appliedAt: daysAgo(60) });
    expect(effectiveStatus(f, 14, NOW)).toBe("ghosted");

    const recent = fact({ lastEventAt: null, appliedAt: daysAgo(3) });
    expect(effectiveStatus(recent, 14, NOW)).toBe("applied");
  });

  it("respects a threshold other than the default", () => {
    const f = fact({ lastEventAt: daysAgo(20) });
    expect(effectiveStatus(f, 30, NOW)).toBe("applied");
    expect(effectiveStatus(f, 7, NOW)).toBe("ghosted");
  });
});

describe("buildFunnel", () => {
  // Peaks: three stalled at applied, two reached screening, one interviewed,
  // one got an offer.
  const facts = [1, 1, 1, 3, 3, 5, 6].map((peakStage) => fact({ peakStage }));

  it("counts each stage as reached-or-passed, so counts never rise", () => {
    const counts = buildFunnel(facts).map((s) => s.reached);
    expect(counts).toEqual([7, 4, 4, 2, 2, 1]);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]!).toBeLessThanOrEqual(counts[i - 1]!);
    }
  });

  it("reports conversion against the previous stage only", () => {
    const stages = buildFunnel(facts);
    expect(stages[0]!.conversion).toBeNull();
    expect(stages[1]!.conversion).toBeCloseTo(4 / 7);
    expect(stages[3]!.conversion).toBeCloseTo(0.5);
    expect(stages[5]!.conversion).toBeCloseTo(0.5);
  });

  it("accounts for every application exactly once in droppedHere", () => {
    const dropped = buildFunnel(facts).map((s) => s.droppedHere);
    expect(dropped).toEqual([3, 0, 2, 0, 1, 1]);
    expect(dropped.reduce((a, b) => a + b, 0)).toBe(facts.length);
  });

  it("returns zeroed stages rather than dividing by zero when there is no data", () => {
    const stages = buildFunnel([]);
    expect(stages).toHaveLength(6);
    expect(stages.every((s) => s.reached === 0 && s.droppedHere === 0)).toBe(true);
    expect(stages.every((s) => s.conversion === null)).toBe(true);
  });
});

describe("buildSources", () => {
  const facts = [
    fact({ ats: "linkedin", peakStage: 1, lastEventAt: daysAgo(60) }),
    fact({ ats: "linkedin", peakStage: 1, lastEventAt: daysAgo(60) }),
    fact({ ats: "linkedin", peakStage: 1, currentStatus: "rejected", lastEventAt: daysAgo(5) }),
    fact({ ats: "greenhouse", peakStage: 5, currentStatus: "interview", lastEventAt: daysAgo(2) }),
    fact({ ats: null, peakStage: 6, currentStatus: "offer", lastEventAt: daysAgo(1) }),
  ];

  it("groups by ATS and buckets an unidentified one as direct", () => {
    const rows = buildSources(facts, 14, NOW);
    expect(rows.map((r) => r.source)).toEqual(["linkedin", "direct", "greenhouse"]);
  });

  it("separates interview rate from volume, which is the comparison worth making", () => {
    const rows = buildSources(facts, 14, NOW);
    const linkedin = rows.find((r) => r.source === "linkedin")!;
    const greenhouse = rows.find((r) => r.source === "greenhouse")!;

    expect(linkedin.applied).toBe(3);
    expect(linkedin.interviewRate).toBe(0);
    expect(greenhouse.applied).toBe(1);
    expect(greenhouse.interviewRate).toBe(1);
  });

  it("counts ghosted per source using the read-time predicate", () => {
    const rows = buildSources(facts, 14, NOW);
    // Two silent for 60 days; the third is a fresh rejection, not silence.
    expect(rows.find((r) => r.source === "linkedin")!.ghosted).toBe(2);
    expect(rows.find((r) => r.source === "greenhouse")!.ghosted).toBe(0);
  });

  it("counts an offer at every stage it passed through", () => {
    const direct = buildSources(facts, 14, NOW).find((r) => r.source === "direct")!;
    expect(direct.offers).toBe(1);
    expect(direct.interviewed).toBe(1);
  });
});

describe("buildResponseTimes", () => {
  const responded = (days: number) =>
    fact({ appliedAt: daysAgo(100), firstResponseAt: daysAgo(100 - days) });

  it("takes the median over responders only", () => {
    const facts = [responded(1), responded(5), responded(9), fact(), fact()];
    const times = buildResponseTimes(facts);
    expect(times.total).toBe(5);
    expect(times.responded).toBe(3);
    expect(times.medianDays).toBeCloseTo(5);
  });

  it("interpolates the median across an even count", () => {
    const times = buildResponseTimes([responded(2), responded(4)]);
    expect(times.medianDays).toBeCloseTo(3);
  });

  it("returns nulls rather than NaN when nothing has responded", () => {
    const times = buildResponseTimes([fact(), fact()]);
    expect(times.responded).toBe(0);
    expect(times.medianDays).toBeNull();
    expect(times.p90Days).toBeNull();
  });

  it("discards a response dated before the application", () => {
    const backwards = fact({ appliedAt: daysAgo(10), firstResponseAt: daysAgo(20) });
    expect(buildResponseTimes([backwards]).responded).toBe(0);
  });
});
