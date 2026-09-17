/**
 * Print the application URL for everything waiting in the queue.
 *
 *   node scripts/queue-urls.mjs            the approved queue
 *   node scripts/queue-urls.mjs --all      include submitted and parked
 *   node scripts/queue-urls.mjs --urls     bare URLs, one per line (pipe-friendly)
 */
import "dotenv/config";
import { getDb, closeDb } from "../src/db.js";

const all = process.argv.includes("--all");
const bare = process.argv.includes("--urls");

const db = await getDb();
const rows = await db
  .collection("jobs")
  .find(
    all
      ? { decision: "approved" }
      : { decision: "approved", submitStatus: "queued" },
    {
      projection: {
        companyName: 1,
        companyToken: 1,
        title: 1,
        applyUrl: 1,
        submitStatus: 1,
        submitAttempts: 1,
        "llmScore.fit": 1,
      },
    },
  )
  .sort({ submitStatus: 1, "llmScore.fit": -1 })
  .toArray();

if (bare) {
  for (const r of rows) if (r.applyUrl) console.log(r.applyUrl);
} else {
  console.log(`${rows.length} job(s)\n`);
  for (const r of rows) {
    const co = String(r.companyName || r.companyToken).slice(0, 18);
    console.log(
      `${String(r.llmScore?.fit ?? "?").padStart(2)}  ${co.padEnd(19)}${String(r.title).slice(0, 44)}` +
        (all ? `   [${r.submitStatus}]` : "") +
        (r.submitAttempts ? ` (${r.submitAttempts} failed attempts)` : ""),
    );
    console.log(`    ${r.applyUrl || "(no apply url)"}\n`);
  }
}
await closeDb();
