import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  buildFunnel,
  buildResponseTimes,
  buildSources,
  effectiveStatus,
  type ApplicationFact,
} from "@/lib/insights";

// Reads live data, and the ghosting predicate depends on the current time, so
// this page is never valid as a cached render.
export const dynamic = "force-dynamic";

/**
 * One row per application. Stage ranks are assigned here rather than in the
 * query layer so the database does the grouping, but they must stay in step
 * with STAGES in src/lib/insights.ts.
 *
 * `greatest(..., 1)` matters: an application whose only event is a `note` or a
 * `rejected` scores 0 from the case expression, and it still reached "applied".
 */
async function load(userId: string) {
  const facts = (await db.execute(sql`
    select
      a.id,
      a.ats,
      a.applied_at,
      a.current_status,
      greatest(coalesce((
        select max(case e.type
          when 'applied'             then 1
          when 'confirmation_received' then 2
          when 'recruiter_outreach'  then 3
          when 'assessment_sent'     then 4
          when 'interview_invite'    then 5
          when 'interview_scheduled' then 5
          when 'offer'               then 6
          else 0
        end)
        from events e where e.application_id = a.id
      ), 1), 1) as peak_stage,
      (select max(e.occurred_at) from events e where e.application_id = a.id) as last_event_at,
      (
        select min(e.occurred_at) from events e
         where e.application_id = a.id
           and e.type not in ('applied', 'confirmation_received', 'note')
      ) as first_response_at
    from applications a
    where a.user_id = ${userId}
  `)) as unknown as Array<{
    id: string;
    ats: string | null;
    applied_at: string | Date;
    current_status: ApplicationFact["currentStatus"];
    peak_stage: number | string;
    last_event_at: string | Date | null;
    first_response_at: string | Date | null;
  }>;

  const settings = (await db.execute(sql`
    select ghost_after_days from users where id = ${userId}
  `)) as unknown as Array<{ ghost_after_days: number | string }>;

  return {
    facts: facts.map(
      (r): ApplicationFact => ({
        id: r.id,
        ats: r.ats,
        appliedAt: new Date(r.applied_at),
        currentStatus: r.current_status,
        peakStage: Number(r.peak_stage),
        lastEventAt: r.last_event_at === null ? null : new Date(r.last_event_at),
        firstResponseAt: r.first_response_at === null ? null : new Date(r.first_response_at),
      }),
    ),
    ghostAfterDays: Number(settings[0]?.ghost_after_days ?? 14),
  };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const days = (n: number | null) => (n === null ? "—" : `${n.toFixed(n < 10 ? 1 : 0)}d`);

export default async function InsightsPage() {
  const userId = process.env.DEFAULT_USER_ID;

  if (!userId) {
    return (
      <main style={page}>
        <h1 style={h1}>Insights</h1>
        <p style={{ color: "var(--muted)" }}>
          <code>DEFAULT_USER_ID</code> is not set. See <code>SETUP.md</code> step 3.
        </p>
      </main>
    );
  }

  const { facts, ghostAfterDays } = await load(userId);
  const now = new Date();

  const funnel = buildFunnel(facts);
  const sources = buildSources(facts, ghostAfterDays, now);
  const response = buildResponseTimes(facts);
  const ghosted = facts.filter((f) => effectiveStatus(f, ghostAfterDays, now) === "ghosted").length;

  if (facts.length === 0) {
    return (
      <main style={page}>
        <Nav />
        <h1 style={h1}>Insights</h1>
        <p style={{ color: "var(--muted)" }}>
          Nothing to measure yet. Run the Apps Script&apos;s <code>backfill()</code> first — these
          numbers all read data the ingester already collects.
        </p>
      </main>
    );
  }

  const widest = funnel[0]!.reached || 1;

  return (
    <main style={page}>
      <Nav />
      <header style={{ marginBottom: 28 }}>
        <h1 style={h1}>Insights</h1>
        <p style={{ color: "var(--muted)", margin: 0 }}>
          {facts.length} application{facts.length === 1 ? "" : "s"} · {ghosted} silent past{" "}
          {ghostAfterDays} days ({pct(ghosted / facts.length)})
        </p>
      </header>

      <Section
        title="Where applications stop"
        note="Each row counts applications that reached that stage or went past it. The conversion column is the one to read: it isolates a single transition instead of compounding every stage above it."
      >
        <div style={{ display: "grid", gap: 6 }}>
          {funnel.map((stage) => (
            <div key={stage.key} style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 108, color: "var(--muted)", flexShrink: 0 }}>{stage.label}</div>
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  background: "var(--panel)",
                  border: "1px solid var(--line)",
                  borderRadius: 4,
                  height: 22,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${(stage.reached / widest) * 100}%`,
                    height: "100%",
                    background: "var(--accent)",
                    opacity: 0.75,
                  }}
                />
              </div>
              <div style={{ width: 52, textAlign: "right", flexShrink: 0 }}>{stage.reached}</div>
              <div style={{ width: 64, textAlign: "right", color: "var(--muted)", flexShrink: 0 }}>
                {stage.conversion === null ? "" : pct(stage.conversion)}
              </div>
              <div style={{ width: 96, textAlign: "right", color: "var(--muted)", flexShrink: 0 }}>
                {stage.droppedHere > 0 ? `${stage.droppedHere} stalled` : ""}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="How long a reply takes"
        note="Measured only over applications that drew a response. Including the silent ones would need a stand-in value for “never”, and whatever number you picked would set the median rather than describe it."
      >
        <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
          <Stat label="Responded" value={`${response.responded} of ${response.total}`} />
          <Stat label="Median" value={days(response.medianDays)} />
          <Stat label="90th percentile" value={days(response.p90Days)} />
        </div>
      </Section>

      <Section
        title="Conversion by source"
        note="Grouped by the ATS or board the application went through — not by how this system found out about it. Volume and interview rate are different questions; a source with many applications and no interviews is the one to stop using."
      >
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--muted)" }}>
              {["Source", "Applied", "Interviewed", "Rate", "Offers", "Rejected", "Silent"].map(
                (h, i) => (
                  <th
                    key={h}
                    style={{
                      padding: "8px 10px",
                      borderBottom: "1px solid var(--line)",
                      fontWeight: 500,
                      whiteSpace: "nowrap",
                      textAlign: i === 0 ? "left" : "right",
                    }}
                  >
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {sources.map((row) => (
              <tr key={row.source}>
                <td style={cell}>{row.source}</td>
                <td style={num}>{row.applied}</td>
                <td style={num}>{row.interviewed}</td>
                <td style={{ ...num, color: row.interviewRate > 0 ? "var(--ink)" : "var(--muted)" }}>
                  {pct(row.interviewRate)}
                </td>
                <td style={num}>{row.offers}</td>
                <td style={num}>{row.rejected}</td>
                <td style={num}>{row.ghosted}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </main>
  );
}

function Nav() {
  return (
    <nav style={{ marginBottom: 20, fontSize: 13 }}>
      <Link href="/">← Applications</Link>
    </nav>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 40 }}>
      <h2 style={{ fontSize: 15, margin: "0 0 4px", fontWeight: 600 }}>{title}</h2>
      <p style={{ color: "var(--muted)", margin: "0 0 16px", maxWidth: 620, fontSize: 13 }}>
        {note}
      </p>
      <div style={{ overflowX: "auto" }}>{children}</div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ color: "var(--muted)", fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 22, letterSpacing: "-0.02em" }}>{value}</div>
    </div>
  );
}

const page: React.CSSProperties = { maxWidth: 900, margin: "0 auto", padding: "40px 16px 80px" };
const h1: React.CSSProperties = { fontSize: 20, margin: "0 0 6px", letterSpacing: "-0.01em" };
const cell: React.CSSProperties = {
  padding: "10px",
  borderBottom: "1px solid var(--line)",
};
const num: React.CSSProperties = { ...cell, textAlign: "right", whiteSpace: "nowrap" };
