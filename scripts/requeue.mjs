/**
 * Put approved jobs back in the queue when nothing was actually submitted.
 *
 *   node scripts/requeue.mjs            show what would change
 *   node scripts/requeue.mjs --apply    do it
 *
 * Needed because a dry run used to write submitStatus: "dry_run_ok", which
 * removed the job from the { decision: approved, submitStatus: queued } filter
 * the real submit step reads. Previewing an application silently consumed it.
 * The write path is fixed; this repairs the rows it already damaged.
 *
 * Only touches rows that were never actually sent. Anything with
 * submitStatus "submitted" is left strictly alone — re-queueing a real
 * application would mean applying twice to the same requisition.
 */
import "dotenv/config";
import { getDb, closeDb } from "../src/db.js";

const apply = process.argv.includes("--apply");
const db = await getDb();
const jobs = db.collection("jobs");

// Every status that means "we did not actually submit". Errors belong here:
// a crash is not a decision, and the first version of this list omitted them,
// so a job that failed on a transient browser-profile timeout stayed parked.
const NEVER_SENT = [
  "dry_run_ok",
  "handed_off",
  "needs_manual_fields",
  "no_form",
  "no_submit_button",
  "error",
  "error_giving_up",
  "needs_manual_captcha",
];

const rows = await jobs
  .find(
    {
      decision: "approved",
      $or: [
        { submitStatus: { $in: NEVER_SENT } },
        { submitStatus: { $regex: "^failed_" } },
      ],
    },
    { projection: { title: 1, companyName: 1, companyToken: 1, submitStatus: 1, "llmScore.fit": 1 } },
  )
  .sort({ "llmScore.fit": -1 })
  .toArray();

console.log(`${rows.length} approved job(s) marked processed but never submitted:\n`);
for (const d of rows)
  console.log(
    `  fit ${String(d.llmScore?.fit ?? "?").padStart(2)}  ${String(d.submitStatus).padEnd(14)}` +
      `${String(d.companyName || d.companyToken).slice(0, 16).padEnd(16)} ${d.title.slice(0, 44)}`,
  );

const sent = await jobs.countDocuments({ submitStatus: "submitted" });
console.log(`\n  (${sent} genuinely submitted — left untouched)`);

if (!apply) {
  console.log("\ndry run — re-run with --apply");
  await closeDb();
  process.exit(0);
}

const r = await jobs.updateMany(
  { _id: { $in: rows.map((d) => d._id) } },
  {
    $set: { submitStatus: "queued" },
    $unset: { submitAttemptAt: "", submitNotes: "", submitAttempts: "" },
  },
);
console.log(`\nrequeued ${r.modifiedCount}`);
console.log(`queue now: ${await jobs.countDocuments({ decision: "approved", submitStatus: "queued" })}`);
await closeDb();
