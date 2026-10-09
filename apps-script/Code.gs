/**
 * AI Job Tracker — Gmail ingester.
 *
 * Runs inside your own Google account on a time-based trigger, searches Gmail
 * for application-related mail, and POSTs it to the tracker's /api/ingest.
 *
 * Why this rather than Gmail OAuth (ARCHITECTURE.md ADR-003): a script you own
 * and authorize for yourself needs no app verification and no CASA assessment.
 * You click through an unverified-app warning once. That means phase 1 needs no
 * domain, no DNS and no inbound mail infrastructure.
 *
 * It does not scale past one user — distributing it would mean publishing a
 * Workspace Add-on with its own review — which is why the forwarding adapter in
 * ADR-001 remains the multi-user design. Both produce the same raw_events rows.
 *
 * SETUP
 *   1. script.google.com -> New project -> paste this file.
 *   2. Project Settings -> Script Properties, add:
 *        API_URL        https://<your-app>/api/ingest   (or an ngrok URL in dev)
 *        INGEST_SECRET  the same value as INGEST_SECRET in .env
 *   3. Run `setup` once. Approve the Gmail scope when prompted; choose
 *      "Advanced" -> "Go to ... (unsafe)" — that warning is expected for a
 *      script you wrote and are authorizing for your own account.
 *   4. Run `backfill` once to import history, then let the trigger handle the
 *      rest. Check `View -> Executions` for logs.
 */

/** How far back `backfill` reaches. */
var BACKFILL_DAYS = 365;

/** Label applied to processed threads, so work is never repeated. */
var PROCESSED_LABEL = "JobTracker/Ingested";

/** Gmail threads per run. Keeps execution inside Apps Script's 6-minute limit. */
var MAX_THREADS_PER_RUN = 50;

/** Emails per HTTP request to the ingest endpoint. */
var BATCH_SIZE = 25;

/** Characters of body text sent. Enough to classify, small enough to be cheap. */
var BODY_CHARS = 6000;

/**
 * Senders and phrases worth looking at. Deliberately broad: the server decides
 * what is actually an application, and anything it does not recognize is
 * archived for review rather than dropped. Narrowing this is how you miss mail.
 */
var SEARCH_QUERY = [
  "(",
  'from:(greenhouse.io OR greenhouse-mail.io OR lever.co OR ashbyhq.com OR',
  'myworkday.com OR myworkdayjobs.com OR smartrecruiters.com OR icims.com OR',
  'taleo.net OR workable.com OR breezy.hr OR teamtailor.com OR jobvite.com OR',
  'linkedin.com OR indeed.com OR indeedemail.com OR naukri.com)',
  "OR",
  'subject:("thank you for applying" OR "application received" OR',
  '"your application" OR "you applied" OR "application was sent" OR',
  '"interview" OR "assessment" OR "we have decided" OR "move forward")',
  ")",
  "-in:spam",
].join(" ");

// ---------------------------------------------------------------------------

function setup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty("API_URL") || !props.getProperty("INGEST_SECRET")) {
    throw new Error("Set API_URL and INGEST_SECRET in Project Settings -> Script Properties first.");
  }

  getOrCreateLabel_(PROCESSED_LABEL);

  // Replace any existing trigger so repeated setup() runs don't stack up.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "poll") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("poll").timeBased().everyHours(1).create();

  Logger.log("Setup complete. Hourly trigger installed. Run backfill() next.");
}

/** Hourly trigger target. Looks at recent mail only. */
function poll() {
  run_("newer_than:2d");
}

/** One-time history import. Safe to re-run; processed threads are skipped. */
function backfill() {
  run_("newer_than:" + BACKFILL_DAYS + "d");
}

function run_(windowClause) {
  var props = PropertiesService.getScriptProperties();
  var apiUrl = props.getProperty("API_URL");
  var secret = props.getProperty("INGEST_SECRET");
  if (!apiUrl || !secret) throw new Error("API_URL / INGEST_SECRET not set.");

  var label = getOrCreateLabel_(PROCESSED_LABEL);
  var query = SEARCH_QUERY + " " + windowClause + ' -label:"' + PROCESSED_LABEL + '"';

  var threads = GmailApp.search(query, 0, MAX_THREADS_PER_RUN);
  Logger.log("Query matched %s thread(s) to process.", threads.length);
  if (threads.length === 0) return;

  var pending = [];
  var totals = { sent: 0, batches: 0 };

  for (var i = 0; i < threads.length; i++) {
    var messages = threads[i].getMessages();
    for (var j = 0; j < messages.length; j++) {
      pending.push(toPayload_(messages[j], threads[i]));
      if (pending.length >= BATCH_SIZE) {
        post_(apiUrl, secret, pending);
        totals.sent += pending.length;
        totals.batches++;
        pending = [];
      }
    }
    // Label only after the thread's messages have been accepted, so a failure
    // mid-run leaves the thread to be retried rather than silently skipped.
    threads[i].addLabel(label);
  }

  if (pending.length > 0) {
    post_(apiUrl, secret, pending);
    totals.sent += pending.length;
    totals.batches++;
  }

  Logger.log("Sent %s message(s) in %s batch(es).", totals.sent, totals.batches);
}

function toPayload_(message, thread) {
  var body = "";
  try {
    body = message.getPlainBody() || "";
  } catch (e) {
    body = message.getBody() ? message.getBody().replace(/<[^>]+>/g, " ") : "";
  }
  return {
    messageId: message.getId(),
    threadId: thread.getId(),
    from: message.getFrom(),
    to: message.getTo(),
    subject: message.getSubject() || "",
    date: message.getDate().toISOString(),
    body: body.slice(0, BODY_CHARS),
  };
}

function post_(apiUrl, secret, emails) {
  var response = UrlFetchApp.fetch(apiUrl, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + secret },
    payload: JSON.stringify({ emails: emails }),
    muteHttpExceptions: true,
  });

  var code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    // Thrown so the execution is marked failed and the thread stays unlabeled.
    throw new Error("Ingest failed (HTTP " + code + "): " + response.getContentText().slice(0, 500));
  }
  Logger.log("Batch of %s accepted: %s", emails.length, response.getContentText().slice(0, 300));
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}
