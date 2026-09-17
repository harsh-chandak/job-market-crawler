/**
 * Remove postings that are too old to be worth applying to.
 *
 *   node scripts/prune-stale-queue.mjs [--days 60]   show what would go
 *   node scripts/prune-stale-queue.mjs --apply       do it
 *   node scripts/prune-stale-queue.mjs --undo        put them back
 *
 * Age is CURRENT age from the date the board claims, not the age when the poller
 * first saw it. claimedLagMs is frozen at first sight, so a job first seen
 * minutes after posting reads as fresh forever.
 *
 * PICK THE CUTOFF CAREFULLY. A first attempt at 60 days would have removed 545
 * postings including nearly every OpenAI and Palantir forward-deployed role.
 * Those dates are real — Ashby reports publishedAt 2025-11-07 for OpenAI's FDE
 * NYC req, genuinely 271 days — but a large employer hiring at volume leaves a
 * pipeline req published for months and reviews in rolling batches. Long-open is
 * not the same as dead, and 60 days is nowhere near the line.
 *
 * The defensible cutoff is years, not months: no live hiring pipeline leaves a
 * requisition open for three. Those dates are real too — Lever reports
 * createdAt 2019-01-17 for a WeRide posting — they are simply reqs nobody closed.
 *
 * Marked, not deleted, and reversible with --undo.
 */
import "dotenv/config";
import { getDb, closeDb } from "../src/db.js";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const DAYS = Number(arg("days", 1095)); // 3 years — see the note above
const apply = process.argv.includes("--apply");
const undo = process.argv.includes("--undo");

const db = await getDb();
const jobs = db.collection("jobs");

if (undo) {
  const r = await jobs.updateMany(
    { status: "stale", staleReason: { $regex: "^age " } },
    { $set: { status: "new" }, $unset: { staleReason: "" } },
  );
  console.log(`restored ${r.modifiedCount}`);
  await closeDb();
  process.exit(0);
}

const cutoff = new Date(Date.now() - DAYS * 86400_000);
const filter = {
  status: "new",
  decision: { $exists: false },
  $or: [
    { postedAtClaimed: { $ne: null, $lt: cutoff } },
    { postedAtClaimed: null, firstSeenAt: { $lt: cutoff } },
  ],
};

const rows = await jobs
  .find(filter, {
    projection: { title: 1, companyName: 1, companyToken: 1, postedAtClaimed: 1, firstSeenAt: 1, "llmScore.fit": 1 },
  })
  .sort({ "llmScore.fit": -1 })
  .toArray();

const ageDays = (j) =>
  Math.round((Date.now() - new Date(j.postedAtClaimed || j.firstSeenAt).getTime()) / 86400_000);

console.log(`${rows.length} undecided posting(s) older than ${DAYS} days:\n`);
for (const j of rows)
  console.log(
    `  fit ${String(j.llmScore?.fit ?? "?").padStart(2)}  ${String(ageDays(j)).padStart(4)}d  ` +
      `${String(j.companyName || j.companyToken).slice(0, 18).padEnd(18)} ${j.title.slice(0, 46)}`,
  );

if (!apply) {
  console.log("\ndry run — re-run with --apply");
  await closeDb();
  process.exit(0);
}

const r = await jobs.updateMany(filter, {
  $set: { status: "stale", staleReason: `age >${DAYS}d at review time` },
});
console.log(`\nremoved ${r.modifiedCount} from the queue`);
console.log(`queue now: ${await jobs.countDocuments({ status: "new", decision: { $exists: false }, "llmScore.fit": { $gte: 70 } })} at fit >= 70`);
await closeDb();
