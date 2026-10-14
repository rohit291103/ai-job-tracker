/**
 * Funnel and conversion math, kept pure.
 *
 * The database returns one row of facts per application; everything derived
 * from those rows is computed here with no I/O, so it can be tested without a
 * database. Design reference: ARCHITECTURE.md section 13.
 *
 * The rule that section sets for this file: every number produced here has to
 * be one that would change a decision. Counts that only describe are left out.
 */
import type { applicationStatus } from "@/db/schema";

export type Status = (typeof applicationStatus.enumValues)[number];

/** One row per application, as loaded by the insights query. */
export type ApplicationFact = {
  id: string;
  /** The ATS or board the application went through; null means applied direct. */
  ats: string | null;
  appliedAt: Date;
  /** Derived by trigger. Does not account for silence — see effectiveStatus. */
  currentStatus: Status;
  /** Highest stage any of this application's events reached. */
  peakStage: number;
  /** Most recent event of any kind, null if the application has no events. */
  lastEventAt: Date | null;
  /** First event that represents a human on the other end responding. */
  firstResponseAt: Date | null;
};

/**
 * Progress stages, in order.
 *
 * Only forward progress gets a rank. `rejected`, `withdrawn` and `note` are
 * deliberately absent: a rejection is an outcome, not a stage, and ranking it
 * would put it in sequence with the stage it interrupted.
 *
 * Note that `acknowledged` reads as a pass-through stage today, because the
 * pipeline emits `applied` for confirmation mail rather than
 * `confirmation_received` — that event type only starts firing once the
 * extension captures the submission itself and the confirmation arrives second.
 * The stage is kept in place so the funnel doesn't need reshaping then.
 */
export const STAGES = [
  { key: "applied", rank: 1, label: "Applied" },
  { key: "acknowledged", rank: 2, label: "Acknowledged" },
  { key: "screening", rank: 3, label: "Screening" },
  { key: "assessment", rank: 4, label: "Assessment" },
  { key: "interview", rank: 5, label: "Interview" },
  { key: "offer", rank: 6, label: "Offer" },
] as const;

export const INTERVIEW_RANK = 5;
export const OFFER_RANK = 6;

/** Stages an application can still be ghosted out of. Past screening, silence means something else. */
const EARLY_STATUSES: ReadonlySet<Status> = new Set<Status>(["applied", "acknowledged"]);

const DAY_MS = 86_400_000;

/**
 * Applies the ghosting predicate.
 *
 * Silence produces no event, so it cannot reach the status trigger — which is
 * why `ghosted` is unreachable as a stored status and is resolved here instead,
 * against the clock, at read time.
 */
export function effectiveStatus(
  fact: Pick<ApplicationFact, "currentStatus" | "lastEventAt" | "appliedAt">,
  ghostAfterDays: number,
  now: Date,
): Status {
  if (!EARLY_STATUSES.has(fact.currentStatus)) return fact.currentStatus;
  // An application with no events at all is still datable: it was applied.
  const last = fact.lastEventAt ?? fact.appliedAt;
  const silentDays = (now.getTime() - last.getTime()) / DAY_MS;
  return silentDays > ghostAfterDays ? "ghosted" : fact.currentStatus;
}

export type FunnelStage = {
  key: string;
  label: string;
  /** Applications that reached this stage or went past it. */
  reached: number;
  /** Share of the previous stage that got this far; null for the first stage. */
  conversion: number | null;
  /** Applications whose furthest progress was exactly this stage. */
  droppedHere: number;
};

/**
 * Counts are "reached or passed", so they fall monotonically — an application
 * that got to interview is counted at every stage below it. That makes the
 * per-stage conversion rate the number worth reading: it isolates one
 * transition instead of compounding all of them.
 */
export function buildFunnel(facts: readonly ApplicationFact[]): FunnelStage[] {
  const reachedAt = (rank: number) => facts.filter((f) => f.peakStage >= rank).length;

  return STAGES.map((stage, i) => {
    const reached = reachedAt(stage.rank);
    const previous = i === 0 ? null : reachedAt(STAGES[i - 1]!.rank);
    const next = i === STAGES.length - 1 ? 0 : reachedAt(STAGES[i + 1]!.rank);
    return {
      key: stage.key,
      label: stage.label,
      reached,
      conversion: previous === null ? null : previous === 0 ? null : reached / previous,
      droppedHere: reached - next,
    };
  });
}

export type SourceRow = {
  /** The ATS or board, or "direct" where none was identified. */
  source: string;
  applied: number;
  interviewed: number;
  offers: number;
  rejected: number;
  ghosted: number;
  /** Share of applications through this source that reached an interview. */
  interviewRate: number;
};

/**
 * Conversion by ATS or board.
 *
 * Grouped by `ats`, not by `capture_source`. Those answer different questions:
 * `ats` is where the application went, `capture_source` is only how this system
 * found out about it, and breaking conversion down by the latter would measure
 * the ingestion pipeline rather than the job search.
 */
export function buildSources(
  facts: readonly ApplicationFact[],
  ghostAfterDays: number,
  now: Date,
): SourceRow[] {
  const groups = new Map<string, ApplicationFact[]>();
  for (const fact of facts) {
    const key = fact.ats ?? "direct";
    const bucket = groups.get(key);
    if (bucket) bucket.push(fact);
    else groups.set(key, [fact]);
  }

  return [...groups.entries()]
    .map(([source, group]) => {
      const interviewed = group.filter((f) => f.peakStage >= INTERVIEW_RANK).length;
      return {
        source,
        applied: group.length,
        interviewed,
        offers: group.filter((f) => f.peakStage >= OFFER_RANK).length,
        rejected: group.filter((f) => f.currentStatus === "rejected").length,
        ghosted: group.filter((f) => effectiveStatus(f, ghostAfterDays, now) === "ghosted").length,
        interviewRate: group.length === 0 ? 0 : interviewed / group.length,
      };
    })
    .sort((a, b) => b.applied - a.applied || a.source.localeCompare(b.source));
}

export type ResponseTimes = {
  /** Applications that drew any human response at all. */
  responded: number;
  total: number;
  /** Days from applying to first response. Null when nothing has responded yet. */
  medianDays: number | null;
  p90Days: number | null;
};

/**
 * How long a response takes when one comes.
 *
 * Deliberately measured only over applications that did get a response.
 * Including silent ones would need a stand-in value for "never", and any
 * number chosen for that would set the median rather than describe it.
 */
export function buildResponseTimes(facts: readonly ApplicationFact[]): ResponseTimes {
  const days = facts
    .filter((f) => f.firstResponseAt !== null)
    .map((f) => (f.firstResponseAt!.getTime() - f.appliedAt.getTime()) / DAY_MS)
    .filter((d) => d >= 0)
    .sort((a, b) => a - b);

  return {
    responded: days.length,
    total: facts.length,
    medianDays: percentile(days, 0.5),
    p90Days: percentile(days, 0.9),
  };
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}
