/**
 * Re-apply the years-of-experience screen to jobs already in the queue.
 *
 *   node scripts/rescreen-yoe.mjs            report
 *   node scripts/rescreen-yoe.mjs --apply    screen them out
 *
 * extractYoE missed two very common phrasings — typographic dash ranges, and
 * "N years working on…" without the literal word "experience" — so postings that
 * stated a five-year bar plainly were read as stating nothing. They passed the
 * screen, were scored at full price, and were shown as matches.
 *
 * This does not rescore anything. The LLM already ran on these; re-running it
 * would pay twice for the same mistake.
 */
import "dotenv/config";
import { getDb, closeDb } from "../src/db.js";
import { extractYoE } from "../src/filter.js";

const apply = process.argv.includes("--apply");
const MAX = Number(process.env.MAX_YOE || 3);

const db = await getDb();
const jobs = db.collection("jobs");

const rows = await jobs
  .find(
    { status: "new", decision: { $exists: false } },
    { projection: { companyToken: 1, title: 1, description: 1, "llmScore.fit": 1, screen: 1 } },
  )
  .toArray();

const over = [];
for (const r of rows) {
  const y = extractYoE(r.description || "");
  if (y !== null && y > MAX) over.push({ ...r, y });
}
over.sort((a, b) => (b.llmScore?.fit ?? 0) - (a.llmScore?.fit ?? 0));

console.log(`${rows.length} undecided job(s) checked against a ${MAX}-year ceiling`);
console.log(`${over.length} demand more than that\n`);
for (const o of over.slice(0, 12))
  console.log(
    `  needs ${String(o.y).padStart(2)}y   fit ${String(o.llmScore?.fit ?? "—").padStart(3)}   ${String(o.companyToken).slice(0, 15).padEnd(16)}${String(o.title).slice(0, 40)}`,
  );
if (over.length > 12) console.log(`  … and ${over.length - 12} more`);

const shown = over.filter((o) => (o.llmScore?.fit ?? 0) >= Number(process.env.MIN_FIT || 70));
console.log(`\n${shown.length} of them are currently being shown to you as matches`);

if (!apply) {
  console.log("\ndry run — re-run with --apply");
  await closeDb();
  process.exit(0);
}

const r = await jobs.updateMany(
  { _id: { $in: over.map((o) => o._id) } },
  { $set: { status: "screened_out", screenedOutReason: "yoe_over_ceiling" } },
);
console.log(`\nscreened out ${r.modifiedCount}`);
await closeDb();
