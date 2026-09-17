#!/usr/bin/env node
/**
 * Record what an employer said back, and report the response rate.
 *
 *   node scripts/outcome.mjs                      report
 *   node scripts/outcome.mjs zoom rejected        record against a matched application
 *   node scripts/outcome.mjs openai interview "recruiter screen 8/20"
 *
 * The pipeline tracked everything up to the moment of sending and nothing
 * after it, so the only question that matters — is this resume working —
 * had no data behind it. Two rejections are noise; forty applications with
 * a known outcome rate are a signal, and this is how they accumulate.
 *
 * No model, no network. One database query.
 */
import "dotenv/config";
import { getDb, closeDb } from "../src/db.js";

const STATES = ["rejected", "interview", "offer", "ghosted", "withdrawn"];
const [needle, state, ...noteParts] = process.argv.slice(2);
const note = noteParts.join(" ");

const db = await getDb();
const jobs = db.collection("jobs");

// ---- report ------------------------------------------------------------
if (!needle) {
  const sent = await jobs.countDocuments({ submitStatus: "submitted" });
  const rows = await jobs
    .find({ submitStatus: "submitted" }, { projection: { reply: 1, submitAttemptAt: 1, companyName: 1, companyToken: 1, title: 1 } })
    .toArray();
  const withReply = rows.filter((r) => r.reply?.state);
  const byState = {};
  for (const r of withReply) byState[r.reply.state] = (byState[r.reply.state] || 0) + 1;

  // Age matters more than the raw rate: an application sent yesterday has not
  // ghosted you, it has simply not answered yet. Only count the ones old
  // enough for silence to mean something.
  const RIPE_DAYS = 21;
  const ripe = rows.filter((r) => r.submitAttemptAt && (Date.now() - new Date(r.submitAttemptAt)) / 864e5 >= RIPE_DAYS);
  const ripeAnswered = ripe.filter((r) => r.reply?.state).length;

  console.log(`\n  ${sent} applications sent · ${withReply.length} have an outcome recorded\n`);
  if (withReply.length) {
    for (const [k, v] of Object.entries(byState).sort((a, b) => b[1] - a[1]))
      console.log(`    ${k.padEnd(11)}${String(v).padStart(4)}   ${((v / withReply.length) * 100).toFixed(0)}% of answered`);
    console.log();
  }
  console.log(`  ${ripe.length} application(s) are ${RIPE_DAYS}+ days old — the only ones where silence means anything.`);
  if (ripe.length) console.log(`    of those, ${ripeAnswered} answered (${((ripeAnswered / ripe.length) * 100).toFixed(0)}%).`);
  else console.log(`    none yet. Too early to judge the resume from silence.`);

  const unanswered = ripe.filter((r) => !r.reply?.state).slice(0, 10);
  if (unanswered.length) {
    console.log(`\n  ripe and still silent:`);
    for (const r of unanswered)
      console.log(`    ${String(r.companyName || r.companyToken).slice(0, 18).padEnd(19)}${String(r.title).slice(0, 44)}`);
  }
  console.log(`\n  record one:  node scripts/outcome.mjs <company> <${STATES.join("|")}> ["note"]\n`);
  await closeDb();
  process.exit(0);
}

// ---- record ------------------------------------------------------------
if (!STATES.includes(state)) {
  console.log(`  state must be one of: ${STATES.join(", ")}`);
  await closeDb();
  process.exit(1);
}

const rx = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
const matches = await jobs
  .find({ submitStatus: "submitted", $or: [{ companyName: rx }, { companyToken: rx }] },
        { projection: { companyName: 1, companyToken: 1, title: 1, submitAttemptAt: 1, reply: 1 } })
  .toArray();

if (!matches.length) {
  console.log(`  no submitted application matches "${needle}"`);
  await closeDb();
  process.exit(1);
}

// Ambiguity is reported, never guessed — recording a rejection against the
// wrong requisition quietly corrupts the only outcome data there is.
if (matches.length > 1) {
  console.log(`  "${needle}" matches ${matches.length} applications — narrow it or pass an id:\n`);
  for (const m of matches)
    console.log(`    ${String(m._id)}  ${String(m.companyName || m.companyToken).slice(0, 16).padEnd(17)}${String(m.title).slice(0, 46)}`);
  console.log();
  await closeDb();
  process.exit(1);
}

const hit = matches[0];
await jobs.updateOne({ _id: hit._id }, { $set: { reply: { state, at: new Date(), note: note || null } } });
const days = Math.round((Date.now() - new Date(hit.submitAttemptAt)) / 864e5);
console.log(`  recorded ${state}: ${hit.companyName || hit.companyToken} — ${hit.title}`);
console.log(`  (${days} day${days === 1 ? "" : "s"} after applying)`);
await closeDb();
