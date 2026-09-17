/**
 * Collapse rows that are the same requisition seen under different tokens.
 *
 *   node scripts/dedupe-jobs.mjs [--apply]
 *
 * The proprietary adapters poll one employer as several pseudo-companies whose
 * search results overlap, so one req can land as several rows with identical
 * clusterKey, contentHash and applyUrl. Left alone, the same job gets scored
 * repeatedly and could be applied to twice.
 *
 * Keeps the EARLIEST firstSeenAt — that row carries the true detection latency,
 * which is the metric the whole system is judged on. Losers are marked, not
 * deleted, so the collapse stays auditable and reversible.
 */
import "dotenv/config";
import { getDb, closeDb } from "../src/db.js";

const apply = process.argv.includes("--apply");
const db = await getDb();
const jobs = db.collection("jobs");

const groups = await jobs.aggregate([
  { $match: { status: { $in: ["new", "stale"] }, clusterKey: { $ne: null } } },
  { $sort: { firstSeenAt: 1 } },
  { $group: { _id: "$clusterKey", ids: { $push: "$_id" }, titles: { $addToSet: "$title" }, n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } },
], { allowDiskUse: true }).toArray();

const losers = groups.flatMap((g) => g.ids.slice(1));
console.log(`${groups.length} duplicate clusters · ${losers.length} rows to collapse`);
for (const g of groups.slice(0, 5)) console.log(`  x${g.n}  ${g.titles[0]?.slice(0, 60)}`);

if (!apply) { console.log("\ndry run — re-run with --apply"); await closeDb(); process.exit(0); }

const r = await jobs.updateMany({ _id: { $in: losers } },
  { $set: { status: "duplicate", duplicateReason: "same clusterKey as an earlier row" } });
console.log(`\ncollapsed ${r.modifiedCount}`);
console.log(`scorable now: ${await jobs.countDocuments({ status: "new", llmScore: { $exists: false }, "screen.roleFamily": { $ne: null },
  $expr: { $gt: [{ $strLenCP: { $ifNull: ["$description", ""] } }, 400] } })}`);
await closeDb();
