import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { applications, companies, events, rawEvents } from "@/db/schema";

// Always rendered per-request: this reads live data and must not be cached at
// build time.
export const dynamic = "force-dynamic";

const STATUS_ORDER = [
  "applied",
  "acknowledged",
  "screening",
  "assessment",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
  "ghosted",
] as const;

async function load(userId: string) {
  const rows = await db
    .select({
      id: applications.id,
      title: applications.title,
      status: applications.currentStatus,
      appliedAt: applications.appliedAt,
      updatedAt: applications.updatedAt,
      ats: applications.ats,
      company: companies.name,
      companyDomain: companies.rootDomain,
      eventCount: sql<number>`(select count(*) from ${events} e where e.application_id = ${applications.id})`,
    })
    .from(applications)
    .leftJoin(companies, eq(applications.companyId, companies.id))
    .where(eq(applications.userId, userId))
    .orderBy(desc(applications.updatedAt))
    .limit(500);

  const needsReview = await db
    .select({ count: sql<number>`count(*)` })
    .from(rawEvents)
    .where(sql`${rawEvents.userId} = ${userId} and ${rawEvents.parseError} is not null`);

  return { rows, needsReview: Number(needsReview[0]?.count ?? 0) };
}

export default async function Page() {
  const userId = process.env.DEFAULT_USER_ID;

  if (!userId) {
    return (
      <main style={{ maxWidth: 760, margin: "0 auto", padding: "48px 16px" }}>
        <h1 style={{ fontSize: 20, margin: "0 0 12px" }}>Job Tracker</h1>
        <p style={{ color: "var(--muted)" }}>
          <code>DEFAULT_USER_ID</code> is not set. See <code>SETUP.md</code> — step 3 creates the
          user row and tells you where to find its id.
        </p>
      </main>
    );
  }

  const { rows, needsReview } = await load(userId);

  const byStatus = STATUS_ORDER.map((s) => ({
    status: s,
    count: rows.filter((r) => r.status === s).length,
  })).filter((g) => g.count > 0);

  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: "40px 16px 80px" }}>
      <header style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 20, margin: "0 0 6px", letterSpacing: "-0.01em" }}>Job Tracker</h1>
        <p style={{ color: "var(--muted)", margin: 0 }}>
          {rows.length} application{rows.length === 1 ? "" : "s"}
          {byStatus.length > 0 && (
            <> · {byStatus.map((g) => `${g.count} ${g.status}`).join(" · ")}</>
          )}
          {needsReview > 0 && (
            <>
              {" "}
              · <strong>{needsReview} message{needsReview === 1 ? "" : "s"} need review</strong>
            </>
          )}
        </p>
      </header>

      {rows.length === 0 ? (
        <div
          style={{
            border: "1px dashed var(--line)",
            borderRadius: 10,
            padding: "32px 24px",
            color: "var(--muted)",
          }}
        >
          <p style={{ margin: "0 0 8px", color: "var(--ink)" }}>Nothing ingested yet.</p>
          <p style={{ margin: 0 }}>
            Install the Apps Script in <code>apps-script/Code.gs</code> and run its{" "}
            <code>backfill()</code> once — it imports the last year of application mail.
          </p>
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 680 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--muted)" }}>
                {["Company", "Role", "Status", "Applied", "Events", "Source"].map((h) => (
                  <th
                    key={h}
                    style={{
                      padding: "8px 10px",
                      borderBottom: "1px solid var(--line)",
                      fontWeight: 500,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={cell}>{r.company ?? <span style={dim}>unknown</span>}</td>
                  <td style={cell}>{r.title}</td>
                  <td style={cell}>
                    <span
                      style={{
                        display: "inline-block",
                        padding: "1px 8px",
                        borderRadius: 999,
                        border: "1px solid var(--line)",
                        background: "var(--panel)",
                        fontSize: 12,
                      }}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td style={{ ...cell, whiteSpace: "nowrap" }}>
                    {r.appliedAt.toISOString().slice(0, 10)}
                  </td>
                  <td style={cell}>{Number(r.eventCount)}</td>
                  <td style={cell}>{r.ats ?? <span style={dim}>—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

const cell: React.CSSProperties = {
  padding: "10px",
  borderBottom: "1px solid var(--line)",
  verticalAlign: "top",
};
const dim: React.CSSProperties = { color: "var(--muted)" };
