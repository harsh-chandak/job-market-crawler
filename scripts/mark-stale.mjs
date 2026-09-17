/**
 * Mark stale backlog postings so scoring and notification skip them.
 *
 *   node scripts/mark-stale.mjs [--hours 24] [--undo]
 *
 * Rule: a posting already older than N hours when first seen cannot serve the
 * first-50-applicants goal, so it is not worth a scoring call — EXCEPT at tier-S
 * employers, where the roles are scarce enough to be worth a late application.
 *
 * Age comes from `claimedLagMs` (the posting date the ATS reported, measured at
 * first sight), never from `firstSeenAt`. For backlog rows firstSeenAt is just
 * when the cold-start sweep ran and says nothing about how old the posting is.
 *
 * MARKED, NOT DELETED. `status: "stale"` is reversible with --undo, and the
 * rows stay available for latency metrics and repost detection. Deleting them
 * would destroy the only record of what the board looked like at ingest.
 */
import "dotenv/config";
import { getDb, closeDb } from "../src/db.js";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i+1] ? process.argv[i+1] : d; };
const HOURS = Number(arg("hours", 24));
const undo = process.argv.includes("--undo");

const db = await getDb();
const jobs = db.collection("jobs");

if (undo) {
  const r = await jobs.updateMany({ status: "stale" }, { $set: { status: "new" }, $unset: { staleReason: "" } });
  console.log(`restored ${r.modifiedCount} jobs`);
  await closeDb();
  process.exit(0);
}

const sTokens = (await db.collection("companies")
  .find({ tier: "S" }, { projection: { ats: 1, token: 1 } }).toArray())
  .map((c) => ({ ats: c.ats, companyToken: c.token }));

const filter = {
  status: "new",
  llmScore: { $exists: false },
  claimedLagMs: { $ne: null, $gte: HOURS * 3600e3 },
  $nor: [{ $or: sTokens }], // tier S is exempt
};

const n = await jobs.countDocuments(filter);
const r = await jobs.updateMany(filter, {
  $set: { status: "stale", staleReason: `>${HOURS}h old at first sight, non-tier-S` },
});
console.log(`marked ${r.modifiedCount} of ${n} stale (>${HOURS}h at first sight, excluding tier S)`);
console.log(`remaining scorable: ${await jobs.countDocuments({ status: "new", llmScore: { $exists: false }, "screen.roleFamily": { $ne: null } })}`);
await closeDb();
