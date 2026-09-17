#!/usr/bin/env node
/**
 * Read employer replies out of exported mail and update application outcomes.
 *
 *   node scripts/import-status-emails.mjs           report, change nothing
 *   node scripts/import-status-emails.mjs --apply   write the outcomes
 *
 * Reads every .eml and .mbox file in ./inbox. Both formats are plain text, so
 * this needs no mail library and no mailbox credentials — the point is that
 * nothing here ever holds a password.
 *
 * Matching is company-first and deliberately conservative. A rejection filed
 * against the wrong row is worse than one left unfiled: it would tell you a
 * live application is dead. Where a company has several open applications and
 * the mail does not name a role, the mail is reported as ambiguous rather than
 * guessed at.
 */
import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, closeDb } from "../src/db.js";
import { classifyStatusEmail, decodeHeader } from "../src/adapters/status-email.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INBOX = process.env.MAIL_INBOX || resolve(ROOT, "inbox");
const apply = process.argv.includes("--apply");

/** Split one .eml or a whole .mbox into individual messages. */
function splitMessages(raw, isMbox) {
  if (!isMbox) return [raw];
  // mbox delimits on a line beginning "From " at the start of a message.
  return raw.split(/\r?\n(?=From \S+@\S+ )/).filter((m) => m.trim());
}

function parseHeaders(msg) {
  const split = msg.search(/\r?\n\r?\n/);
  const head = split === -1 ? msg : msg.slice(0, split);
  const body = split === -1 ? "" : msg.slice(split);
  // Unfold continuation lines before reading headers.
  const unfolded = head.replace(/\r?\n[ \t]+/g, " ");
  const get = (n) =>
    (unfolded.match(new RegExp(`^${n}:\\s*(.+)$`, "im")) || [])[1]?.trim() || "";
  return {
    subject: decodeHeader(get("Subject")),
    from: decodeHeader(get("From")),
    date: get("Date"),
    body,
  };
}

const norm = (s) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "")
    .replace(/(inc|llc|corp|corporation|ltd|limited|technologies|technology|labs)$/, "");

if (!existsSync(INBOX)) {
  console.log(`\n  No inbox folder. Create one and drop mail in it:\n    ${INBOX}\n`);
  process.exit(0);
}
const files = (await readdir(INBOX)).filter((f) => /\.(eml|mbox|txt)$/i.test(f));
if (!files.length) {
  console.log(`\n  ${INBOX} is empty.`);
  console.log(`  Drop .eml or .mbox files there — see "10 — Update From Email" for how.\n`);
  process.exit(0);
}

const db = await getDb();
const jobs = db.collection("jobs");

// Only applications that actually went out can receive an outcome.
const sent = await jobs.find(
  { submitStatus: "submitted" },
  { projection: { companyName: 1, companyNorm: 1, title: 1, outcome: 1, submitAttemptAt: 1 } },
).toArray();
const byCo = new Map();
for (const j of sent) {
  const k = j.companyNorm || norm(j.companyName);
  if (!byCo.has(k)) byCo.set(k, []);
  byCo.get(k).push(j);
}

let seen = 0, classified = 0, matched = 0, ambiguous = 0, unknown = 0, noApp = 0;
const writes = [], review = [];

for (const f of files) {
  const raw = await readFile(resolve(INBOX, f), "utf8");
  for (const msg of splitMessages(raw, extname(f).toLowerCase() === ".mbox")) {
    seen++;
    const h = parseHeaders(msg);
    const c = classifyStatusEmail({ subject: h.subject, from: h.from, body: h.body });
    if (!c.status) { unknown++; review.push([f, h.subject, "no rule matched"]); continue; }
    classified++;

    // Exact normalised match first, then a contained-name match. Employers sign
    // mail with a longer name than the board carries — "Cerebras Systems" for
    // cerebras, "Charles River Associates" for crai — and an exact-only lookup
    // sent 94 of 213 messages to the review pile for a spelling difference.
    // Both directions, and only when the shorter side is long enough that a
    // coincidence is implausible.
    const key = norm(c.company);
    let cands = byCo.get(key) || [];
    if (!cands.length && key.length >= 4) {
      for (const [k, v] of byCo) {
        if (k.length < 4) continue;
        if (k.startsWith(key) || key.startsWith(k) || k.includes(key) || key.includes(k)) {
          cands = cands.concat(v);
        }
      }
      // A name matching several different employers is not a match at all.
      const distinct = new Set(cands.map((j) => j.companyNorm));
      if (distinct.size > 1) cands = [];
    }
    if (!cands.length) { noApp++; review.push([f, h.subject, `no application to "${c.company}"`]); continue; }

    let pick = cands;
    if (cands.length > 1 && c.role) {
      const r = c.role.toLowerCase();
      const narrowed = cands.filter((j) => String(j.title).toLowerCase().includes(r) || r.includes(String(j.title).toLowerCase()));
      if (narrowed.length) pick = narrowed;
    }
    if (pick.length > 1) {
      // A rejection is safe to apply to every open application at a company
      // ONLY if it names no role — and it usually does not mean that. Report it.
      ambiguous++;
      // Say WHY it could not be pinned. "No role named" was printed even when a
      // role had been extracted and simply matched every open application,
      // which sent me looking for a parsing bug that was not there.
      review.push([f, h.subject,
        c.role
          ? `${c.status}: "${c.role}" matches ${pick.length} applications at ${c.company}`
          : `${c.status}: ${pick.length} open at ${c.company}, mail names no role`]);
      continue;
    }
    // An employer cannot answer an application that had not been sent yet.
    // A reply predating the submission belongs to an EARLIER application to the
    // same company — a previous round, or one made by hand outside this tool —
    // and filing it here would report a live application as dead. Four did
    // exactly that: Microsoft, Plaid, Glean and Figma rejections landed on
    // applications sent days after the mail arrived.
    const sentAt = pick[0].submitAttemptAt ? new Date(pick[0].submitAttemptAt) : null;
    const mailAt = Number.isFinite(Date.parse(h.date)) ? new Date(h.date) : null;
    if (sentAt && mailAt && mailAt < sentAt - 3600_000) {
      ambiguous++;
      review.push([f, h.subject,
        `${c.status} at ${c.company} predates the application by ${Math.round((sentAt - mailAt) / 864e5)}d — earlier application, not this one`]);
      continue;
    }

    matched++;
    writes.push({ job: pick[0], status: c.status, subject: h.subject, date: h.date });
  }
}

console.log(`\n  ${seen} message(s) in ${files.length} file(s)`);
console.log(`  classified ${classified} · matched ${matched} · ambiguous ${ambiguous} · unrecognised ${unknown} · no matching application ${noApp}\n`);

if (writes.length) {
  const tally = {};
  for (const w of writes) tally[w.status] = (tally[w.status] || 0) + 1;
  console.log(`  outcomes to record: ${JSON.stringify(tally)}`);
  for (const w of writes.slice(0, 15))
    console.log(`    ${w.status.padEnd(13)}${String(w.job.companyName).slice(0, 18).padEnd(19)}${String(w.job.title).slice(0, 40)}`);
  if (writes.length > 15) console.log(`    … and ${writes.length - 15} more`);
}
if (review.length) {
  console.log(`\n  needs your eyes (${review.length}):`);
  for (const [f, s, why] of review.slice(0, 10))
    console.log(`    ${String(s).slice(0, 44).padEnd(45)}${why}`);
  if (review.length > 10) console.log(`    … and ${review.length - 10} more`);
}

if (!apply) {
  console.log(`\n  dry run — re-run with --apply to record these.\n`);
  await closeDb();
  process.exit(0);
}

// An application collects several emails: the autoresponder, then a rejection
// weeks later. Twenty of 109 writes landed on a job that already had one, and
// whichever came last in the file won — mbox order is not chronological, so
// seven real rejections were overwritten by their own acknowledgement.
//
// Order by the message Date so the newest genuinely wins, and never let a
// weaker outcome replace a stronger one at the same instant. "Acknowledged"
// means the form submitted; it can never be news once anything else is known.
const RANK = { acknowledged: 0, assessment: 1, interview: 2, rejected: 3, offer: 4 };
const best = new Map();
for (const w of writes) {
  const t = Date.parse(w.date) || 0;
  const cur = best.get(String(w.job._id));
  if (!cur) { best.set(String(w.job._id), { ...w, t }); continue; }
  const newer = t > cur.t;
  const sameMoment = t === cur.t;
  if (newer || (sameMoment && RANK[w.status] > RANK[cur.status])) best.set(String(w.job._id), { ...w, t });
}
const collapsed = [...best.values()];
if (collapsed.length !== writes.length)
  console.log(`  ${writes.length - collapsed.length} message(s) superseded by a later one for the same application`);

// Only these reach the tracker. It has no "acknowledged" button because an
// autoresponder is not an answer.
const REPLY_STATE = { rejected: "rejected", interview: "interview", offer: "offer" };

let wrote = 0, skippedManual = 0;
for (const w of collapsed) {
  // A mark made by hand outranks anything parsed out of mail. Filtering on it
  // here means a re-import cannot quietly undo a correction you made in the UI.
  const manual = await jobs.findOne(
    { _id: w.job._id, "reply.state": { $exists: true }, "reply.source": { $ne: "email" } },
    { projection: { _id: 1 } },
  );
  if (manual) {
    skippedManual++;
    continue;
  }
  const r = await jobs.updateOne(
    { _id: w.job._id },
    {
      $set: {
        outcome: w.status,
        // WHEN THE EMPLOYER SENT IT, not when this ran. Stamping import time made
        // every rejection look as though it arrived the moment the mbox was read,
        // so "time from application to rejection" was really just application age.
        outcomeAt: Number.isFinite(Date.parse(w.date)) ? new Date(w.date) : new Date(),
        outcomeDateKnown: Number.isFinite(Date.parse(w.date)),
        outcomeSource: "email",
        outcomeSubject: String(w.subject).slice(0, 200),
        // The tracker page reads `reply.state`, set by its own R/I/O/G buttons.
        // Writing only `outcome` left two status systems that never met: the
        // tracker showed 6 answered and 6 rejected while the mail said 87 and
        // 10. Same field now, tagged so a human mark can be told apart from a
        // parsed one — and never overwriting a human mark, which is the whole
        // reason the buttons exist.
        //
        // "acknowledged" is not a reply state. An autoresponder is not an
        // answer, and recording it as one would call every application
        // answered.
        ...(REPLY_STATE[w.status]
          ? {
              reply: {
                state: REPLY_STATE[w.status],
                at: Number.isFinite(Date.parse(w.date)) ? new Date(w.date) : new Date(),
                note: String(w.subject).slice(0, 120),
                source: "email",
              },
            }
          : {}),
      },
    },
  );
  wrote += r.modifiedCount;
}
console.log(`\n  recorded ${wrote} outcome(s).` + (skippedManual ? ` ${skippedManual} left alone — you had marked them by hand.` : "") + "\n");
await closeDb();
