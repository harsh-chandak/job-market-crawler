/**
 * Rank the unscored backlog deterministically and persist the result.
 *
 *   node scripts/prerank-backlog.mjs
 *
 * Writes `prerank` to every unscored job with a usable description. Nothing
 * here touches `llmScore` — this only decides what is worth spending the model
 * on, in what order.
 */
import "dotenv/config";
import { getDb, closeDb } from "../src/db.js";
import { prerank } from "../src/prerank.js";

const db = await getDb();
const jobs = db.collection("jobs");
const companies = db.collection("companies");

const cos = new Map(
  (await companies.find({}, { projection: { ats: 1, token: 1, sponsorship: 1, isTarget: 1, name: 1 } }).toArray())
    .map((c) => [`${c.ats}:${c.token}`, c]),
);

const cur = jobs.find({
  llmScore: { $exists: false },
  "screen.roleFamily": { $ne: null },
  $expr: { $gt: [{ $strLenCP: { $ifNull: ["$description", ""] } }, 400] },
});

let n = 0, pending = [];
const buckets = { "80+": 0, "70-79": 0, "60-69": 0, "50-59": 0, "<50": 0 };
for await (const job of cur) {
  const co = cos.get(`${job.ats}:${job.companyToken}`) || {};
  const p = prerank(job, co);
  pending.push({ updateOne: { filter: { _id: job._id }, update: { $set: { prerank: p } } } });
  const b = p.score >= 80 ? "80+" : p.score >= 70 ? "70-79" : p.score >= 60 ? "60-69" : p.score >= 50 ? "50-59" : "<50";
  buckets[b]++;
  n++;
  if (pending.length >= 500) { await jobs.bulkWrite(pending, { ordered: false }); pending = []; }
}
if (pending.length) await jobs.bulkWrite(pending, { ordered: false });

console.log(`pre-ranked ${n} jobs\n`);
for (const [k, v] of Object.entries(buckets)) console.log(`  ${k.padEnd(7)} ${String(v).padStart(5)}`);
await closeDb();
