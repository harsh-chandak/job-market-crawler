/**
 * Clear the queue of postings the candidate cannot apply to, cheaply.
 *
 *   node scripts/triage-queue.mjs [--limit 1000] [--floor 0] [--batch 5] [--concurrency 4] [--dry-run]
 *
 * Runs src/triage.js (Haiku by default, TRIAGE_MODEL to change) over unscored
 * postings in the queue, newest first. A job is removed only when the verdict
 * passes acceptRejection: a named blocker, a quote found in the posting, and
 * for years a requirement of 4+. Removed jobs get status "triaged_out" with the
 * verdict attached; kept jobs get triage.qualified so they are not re-checked.
 * Stops cleanly if the Max plan pauses; run again later to continue.
 */
import "dotenv/config";
import { getDb, closeDb } from "../src/db.js";
import { triageBatch, TRIAGE_MODEL } from "../src/triage.js";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const limit = Number(arg("limit", 5000));
const floor = Number(arg("floor", 0));
const concurrency = Number(arg("concurrency", 4));
const dry = process.argv.includes("--dry-run");

const db = await getDb();
const jobs = db.collection("jobs");
const queue = await jobs
  .find({
    status: "new",
    llmScore: { $exists: false },
    triage: { $exists: false },
    $expr: { $gt: [{ $strLenCP: { $ifNull: ["$description", ""] } }, 400] },
    ...(floor ? { "prerank.score": { $gte: floor } } : {}),
  })
  .sort({ firstSeenAt: -1 })
  .limit(limit)
  .toArray();

console.log(
  `triage with ${TRIAGE_MODEL}: ${queue.length} posting(s)${dry ? " (dry run, nothing saved)" : ""}`,
);
const t0 = Date.now();
const out = {};
let kept = 0,
  done = 0,
  paused = null;
const samples = [];

const B = Math.max(1, Number(arg("batch", 5)));
const chunks = [];
for (let i = 0; i < queue.length; i += B) chunks.push(queue.slice(i, i + B));
let next = 0;
async function worker() {
  while (next < chunks.length && !paused) {
    const chunk = chunks[next++];
    let verdicts;
    try {
      verdicts = await triageBatch(chunk);
    } catch (e) {
      if (/paused|usage limit|session limit|did not answer/i.test(String(e.message))) paused = e.message;
      continue;
    }
    for (const [k, job] of chunk.entries()) {
      const v = verdicts[k];
      if (!v) continue; // no verdict for it this time; it stays in the queue for the next run
      done++;
      const verdict = { qualified: !v.remove, blocker: v.blocker, requiredYears: v.requiredYears, quote: v.quote, why: v.why, model: v.model, at: new Date() };
      if (v.remove) {
        out[v.blocker] = (out[v.blocker] || 0) + 1;
        if (samples.length < 8)
          samples.push(`${(job.companyName || "").slice(0, 18).padEnd(18)} ${job.title.slice(0, 44).padEnd(44)} ${v.blocker}: "${String(v.quote).slice(0, 70)}"`);
        if (!dry) await jobs.updateOne({ _id: job._id }, { $set: { status: "triaged_out", triage: verdict } });
      } else {
        kept++;
        if (!dry) await jobs.updateOne({ _id: job._id }, { $set: { triage: verdict } });
      }
    }
    process.stdout.write(`  ${done}/${queue.length}\n`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

const removed = Object.values(out).reduce((a, b) => a + b, 0);
console.log(
  `\nchecked ${done} in ${((Date.now() - t0) / 1000).toFixed(0)}s: kept ${kept}, removed ${removed}`,
);
for (const [k, n] of Object.entries(out).sort((a, b) => b[1] - a[1]))
  console.log(`  ${k.padEnd(26)} ${n}`);
if (samples.length)
  console.log("\nexamples removed:\n  " + samples.join("\n  "));
if (paused)
  console.log(
    `\nstopped early: ${paused.slice(0, 100)}. Run again later to continue.`,
  );
await closeDb();
