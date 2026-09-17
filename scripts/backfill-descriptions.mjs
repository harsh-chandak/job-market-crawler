#!/usr/bin/env node
/**
 * Greenhouse and Amazon descriptions were stored as raw HTML and cut at
 * MAX_DESC_CHARS. Markup ate 16% of the budget, so on long postings the
 * requirements fell off the end while the "About the Company" boilerplate
 * survived. poller.js now converts before it cuts, but it only ever inserts —
 * existing rows are never rewritten. This backfills them.
 *
 * Two passes. The first is free and local: convert the stored HTML to text.
 * That alone buys back the markup overhead. The second pass covers rows that
 * were truncated, where the tail is genuinely gone and no amount of local
 * cleanup recovers it — those get re-fetched from the board. Board fetches are
 * plain HTTP against the ATS, one call per company, and cost nothing.
 *
 * Never touches a row's screen verdict or score. It rewrites description only;
 * re-screening is the loop's job, and doing it here would race the loop.
 */
import "dotenv/config";
import { getDb, closeDb } from "../src/db.js";
import { htmlToText, fetchBoard } from "../src/adapters/index.js";
import { descriptionText } from "../src/poller.js";

const CAP = Number(process.env.MAX_DESC_CHARS || 5000);
const LOOKS_HTML = /<(p|div|span|li|ul|ol|br|strong|em|h[1-6])\b|<\/(p|div|span|li)>/i;
const REFETCH = process.argv.includes("--refetch");

const db = await getDb();
const jobs = db.collection("jobs");

// ---- pass 1: local conversion -------------------------------------------
const html = await jobs
  .find({ description: { $regex: "<(p|div|span|li|br|strong)\\b" } },
        { projection: { description: 1, ats: 1, companyToken: 1 } })
  .toArray();

console.log(`pass 1  ${html.length} row(s) stored as HTML`);
let rawChars = 0, txtChars = 0, freed = 0;
const ops = [];
for (const r of html) {
  const before = r.description || "";
  const after = htmlToText(before).slice(0, CAP);
  if (!after || after === before) continue;
  rawChars += before.length;
  txtChars += after.length;
  if (before.length >= CAP && after.length < CAP) freed++;
  ops.push({ updateOne: { filter: { _id: r._id }, update: { $set: { description: after } } } });
}
if (ops.length) await jobs.bulkWrite(ops, { ordered: false });
console.log(`        ${ops.length} rewritten · ${Math.round((1 - txtChars / (rawChars || 1)) * 100)}% markup dropped`);
console.log(`        ${freed} row(s) no longer at the cap`);

// ---- pass 2: re-fetch what the boards can still tell us ------------------
//
// "Currently at the cap" is the wrong test. A row cut at 5000 characters of HTML
// converts down to ~2000 characters of text in pass 1 and stops looking
// truncated, but the tail that was discarded before storage is still gone. The
// Torc Robotics rows sat at 2021, 1370 and 3709 characters and every one of them
// was missing its qualifications section.
//
// The honest test is to ask the board and compare. One HTTP call per company,
// no LLM, and a row is only rewritten when the board genuinely has more text.
const stillCapped = await jobs.distinct("companyToken", {
  ats: { $in: ["greenhouse", "amazon"] },
});
console.log(`\npass 2  ${stillCapped.length} board(s) to re-check against stored text`);
if (!REFETCH) {
  console.log("        (dry run — pass --refetch to pull full text from the boards)");
  await closeDb();
  process.exit(0);
}

const companies = db.collection("companies");
let fixed = 0, boards = 0, failed = 0;
for (const token of stillCapped) {
  const company = await companies.findOne({ token });
  if (!company) continue;
  // fetchBoard returns {status, jobs, error} — never a bare array.
  let res;
  try {
    // The company record carries the ETag from the last poll, and passing it
    // back gets a 304 with zero jobs — which is exactly right for polling and
    // exactly wrong here, because the rows are stale on our side, not theirs.
    res = await fetchBoard({ ...company, etag: undefined, lastModified: undefined });
  } catch {
    failed++;
    continue;
  }
  if (!res || res.status === "error" || !Array.isArray(res.jobs)) {
    failed++;
    continue;
  }
  boards++;
  const byId = new Map(res.jobs.map((p) => [String(p.sourceJobId), p]));
  const rows = await jobs
    .find({ companyToken: token }, { projection: { sourceJobId: 1, description: 1 } })
    .toArray();
  const batch = [];
  for (const r of rows) {
    const fresh = byId.get(String(r.sourceJobId));
    if (!fresh?.description) continue;
    const text = descriptionText(fresh.description);
    // Only grow a description, never shrink one. A board that transiently serves
    // a stub must not be allowed to erase text we already hold.
    if (text && text.length > (r.description || "").length * 1.1) {
      batch.push({ updateOne: { filter: { _id: r._id }, update: { $set: { description: text } } } });
    }
  }
  if (batch.length) {
    await jobs.bulkWrite(batch, { ordered: false });
    fixed += batch.length;
  }
}
console.log(`        ${boards} board(s) fetched · ${failed} failed · ${fixed} description(s) refreshed`);
await closeDb();
