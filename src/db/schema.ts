/**
 * Drizzle schema. Mirrors supabase/migrations/0001_initial_schema.sql, which is
 * the source of truth — if these disagree, the SQL is right and this is stale.
 *
 * Design reference: ARCHITECTURE.md sections 4 and 5.
 */
import {
  pgEnum,
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  index,
  uniqueIndex,
  unique,
} from "drizzle-orm/pg-core";

export const applicationStatus = pgEnum("application_status", [
  "applied",
  "acknowledged",
  "screening",
  "assessment",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
  "ghosted",
]);

export const eventType = pgEnum("event_type", [
  "applied",
  "confirmation_received",
  "recruiter_outreach",
  "assessment_sent",
  "interview_invite",
  "interview_scheduled",
  "rejected",
  "offer",
  "withdrawn",
  "note",
]);

export const captureSource = pgEnum("capture_source", ["email", "extension", "manual"]);

export const ingestChannel = pgEnum("ingest_channel", [
  "apps_script",
  "email_forward",
  "extension",
  "manual",
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  inboundToken: text("inbound_token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    rootDomain: text("root_domain"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("companies_root_domain_key").on(t.rootDomain)],
);

export const applications = pgTable(
  "applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    normalizedTitle: text("normalized_title").notNull(),
    source: captureSource("source").notNull(),
    externalUrl: text("external_url"),
    ats: text("ats"),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull(),
    /**
     * Derived, not authoritative. Maintained by the `events_refresh_status`
     * trigger. Never write this directly — write an event and let the trigger
     * recompute it.
     */
    currentStatus: applicationStatus("current_status").notNull().default("applied"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("applications_match_key").on(t.userId, t.companyId, t.normalizedTitle, t.appliedAt),
    index("applications_status").on(t.userId, t.currentStatus),
  ],
);

/** Append-only. The database rejects UPDATE and DELETE on this table. */
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    type: eventType("type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    source: captureSource("source").notNull(),
    rawEventId: uuid("raw_event_id"),
    summary: text("summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("events_application").on(t.applicationId, t.occurredAt),
    index("events_user_occurred").on(t.userId, t.occurredAt),
  ],
);

/** The permanent archive. Also the eval set for the classifier. */
export const rawEvents = pgTable(
  "raw_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channel: ingestChannel("channel").notNull(),
    externalId: text("external_id"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb("payload").notNull(),
    parsedAt: timestamp("parsed_at", { withTimezone: true }),
    parserVersion: text("parser_version"),
    parseError: text("parse_error"),
    applicationId: uuid("application_id").references(() => applications.id, {
      onDelete: "set null",
    }),
  },
  (t) => [uniqueIndex("raw_events_dedupe").on(t.userId, t.channel, t.externalId)],
);

export const resumeVersions = pgTable(
  "resume_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    fileRef: text("file_ref"),
    tailoredFor: uuid("tailored_for").references(() => applications.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("resume_versions_user").on(t.userId, t.createdAt)],
);

export const jobDescriptions = pgTable(
  "job_descriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("job_descriptions_application").on(t.applicationId)],
);

export const questionBank = pgTable(
  "question_bank",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    normalizedQuestion: text("normalized_question").notNull(),
    answer: text("answer").notNull(),
    timesUsed: integer("times_used").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("question_bank_user_id_normalized_question_key").on(t.userId, t.normalizedQuestion)],
);

export type Application = typeof applications.$inferSelect;
export type NewApplication = typeof applications.$inferInsert;
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type RawEvent = typeof rawEvents.$inferSelect;
export type Company = typeof companies.$inferSelect;
